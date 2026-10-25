// Servidor "GEATOR RENT" dentro do bot: a app GEATOR BOT MOBILE liga-se aqui,
// recebe as entregas de megas (fila no Supabase) e devolve o resultado.
import express from 'express';
import crypto from 'node:crypto';
import { rpc } from './db.js';

const SESSAO = 'sessao-fastshop';
const SIM = Number(process.env.GEATOR_SIM || 1) === 2 ? 2 : 1;
const SIMS = { 1: 1, 2: 2 };
const codigos = new Map(); // GEATOR-123456 -> expira
let apps = {}; // appId -> { token, dispositivo, visto }
let carregado = false;
let ultimaConsulta = 0;
export const geatorEstado = { visto: 0, dispositivo: '', ultimo: '', erro: '' };

async function carregar() {
  if (carregado) return;
  const r = await rpc('bot_auth_get', { p_keys: ['geator-apps'] });
  apps = JSON.parse(r?.['geator-apps'] || '{}');
  carregado = true;
}
const guardar = () => rpc('bot_auth_set', { p_data: { 'geator-apps': JSON.stringify(apps) } });

export function novoCodigo() {
  const c = 'GEATOR-' + String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  codigos.set(c, Date.now() + 15 * 60_000);
  return c;
}
export function acordarFila() { ultimaConsulta = 0; }

// "1GB", "1.5gb", "1024", "500mb" -> MB
export function paraMB(t) {
  const m = String(t || '').replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(gb|g|mb|m)?$/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  return Math.round(/^g/i.test(m[2] || '') ? v * 1024 : v);
}

export function montarGeator(app, { avisar }) {
  const api = express.Router();
  api.use(express.json({ limit: '200kb' }));

  const auth = async (req, res, next) => {
    try {
      await carregar();
      const id = req.get('x-geator-app-id') || '';
      if (req.get('x-geator-session') !== SESSAO || !apps[id] || apps[id].token !== req.get('x-geator-token')) {
        return res.status(401).json({ ok: false, erro: 'App não pareada. Gera novo código com !pairapp' });
      }
      apps[id].visto = Date.now();
      geatorEstado.visto = Date.now(); geatorEstado.dispositivo = apps[id].dispositivo || '';
      next();
    } catch (e) { geatorEstado.erro = e.message; res.status(500).json({ ok: false, erro: e.message }); }
  };

  api.post('/app/pair', async (req, res) => {
    try {
      await carregar();
      const c = String(req.body?.codigo || '').trim().toUpperCase();
      if (!codigos.has(c) || codigos.get(c) < Date.now()) return res.status(403).json({ ok: false, erro: 'Código inválido ou expirado. Gera outro com !pairapp' });
      codigos.delete(c);
      const appId = 'app-' + crypto.randomBytes(6).toString('hex');
      const token = crypto.randomBytes(24).toString('hex');
      apps = { [appId]: { token, dispositivo: String(req.body?.dispositivo || '').slice(0, 60), criado: Date.now() } }; // só 1 telemóvel
      await guardar();
      res.json({ ok: true, tenantId: SESSAO, token, appId, telefoneNumero: 1, sims: SIMS });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  api.post('/app/heartbeat', auth, (req, res) => {
    const id = req.get('x-geator-app-id');
    if (req.body?.dispositivo) apps[id].dispositivo = String(req.body.dispositivo).slice(0, 60);
    res.json({ ok: true, app: { telefoneNumero: 1, sims: SIMS, estado: 'online' } });
  });

  api.get('/protocolo', auth, (_q, res) => res.json({ ok: true, protocolo: 'geator-rent', servidor: 'FAST SHOP 24H' }));

  api.get('/pedidos/proximo', auth, async (req, res) => {
    if (Date.now() - ultimaConsulta < 4000) return res.json({ ok: true, pedido: null });
    ultimaConsulta = Date.now();
    try {
      const mods = ['diario'];
      if (req.get('x-geator-semanal') === '1') mods.push('semanal');
      if (req.get('x-geator-mensal') === '1') mods.push('mensal');
      const lease = crypto.randomBytes(8).toString('hex');
      const p = await rpc('geator_proximo', { p_lease: lease, p_modalidades: mods });
      if (!p) return res.json({ ok: true, pedido: null });
      ultimaConsulta = 0;
      geatorEstado.ultimo = `#${p.id} ${p.mb}MB → ${p.numero}`;
      res.json({ ok: true, pedido: { id: String(p.id), numero: p.numero, mb: p.mb, simSlot: p.sim_slot === 2 ? 2 : SIM,
        pacote: p.pacote || `${p.mb}MB`, modalidade: p.modalidade, opcaoUssd: p.opcao_ussd || 0, leaseId: lease } });
    } catch (e) { geatorEstado.erro = e.message; res.json({ ok: false, erro: e.message }); }
  });

  api.post('/pedidos/:id/ack', auth, async (req, res) => {
    try { res.json({ ok: Boolean(await rpc('geator_ack', { p_id: Number(req.params.id), p_lease: String(req.body?.leaseId || '') })) }); }
    catch (e) { res.json({ ok: false, erro: e.message }); }
  });

  api.post('/pedidos/:id/resultado', auth, async (req, res) => {
    try {
      const b = req.body || {};
      const ok = b.sucesso === true || b.sucesso === 'true';
      const msg = [b.codigo, b.mensagem].filter(Boolean).join(' • ').slice(0, 400);
      const r = await rpc('geator_resultado', { p_id: Number(req.params.id), p_ok: ok, p_msg: msg });
      res.json({ ok: true });
      acordarFila();
      if (r?.id) avisar(r, ok, msg).catch((e) => console.error('geator aviso', e.message));
    } catch (e) { res.json({ ok: false, erro: e.message }); }
  });

  api.post('/sms', auth, async (req, res) => {
    try {
      const texto = String(req.body?.texto || '');
      const de = String(req.body?.origemSms || '');
      if (/recebe|received|confirmad/i.test(texto) && texto.length >= 10) await rpc('bot_ingest_sms', { p_text: texto, p_sender: de });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, erro: e.message }); }
  });

  api.post('/executor/controle/:id', auth, (_q, res) => res.json({ ok: true }));
  app.use('/api/rent', api);
}
