// Servidor "GEATOR RENT" dentro do bot: a app GEATOR BOT MOBILE liga-se aqui,
// recebe as entregas de megas (fila no Supabase) e devolve o resultado.
import express from 'express';
import crypto from 'node:crypto';
import { rpc } from './db.js';

const SESSAO = 'sessao-fastshop';
const SIMS = { 1: 1, 2: 2 };
const codigos = new Map(); // GEATOR-123456 -> expira
let apps = {}; // appId -> { token, dispositivo, criado, ordem, visto, semMegas, pausado, ok, falhas, ultimo }
let carregado = false;
let ultimaConsulta = 0;
export const geatorEstado = { visto: 0, dispositivo: '', ultimo: '', erro: '' };

async function carregar() {
  if (carregado) return;
  const r = await rpc('bot_auth_get', { p_keys: ['geator-apps'] });
  apps = JSON.parse(r?.['geator-apps'] || '{}');
  Object.values(apps).sort((x, y) => (x.criado || 0) - (y.criado || 0)).forEach((x, i) => { if (!x.ordem) x.ordem = i + 1; });
  carregado = true;
}
const guardar = () => rpc('bot_auth_set', { p_data: { 'geator-apps': JSON.stringify(apps) } });

const ONLINE_MS = 120_000;
const SEM_MEGAS = /insuficiente|sem saldo|saldo baix|n[aã]o (tem|possui|dispõe de) (saldo|megas|dados|pacote|internet)|insufficient|not enough|sem megas|sem dados/i;
const ordenadas = () => Object.entries(apps).sort((a, b) => (a[1].ordem || 99) - (b[1].ordem || 99));
const online = (a) => a.visto && Date.now() - a.visto < ONLINE_MS;
// Cada celular tem 2 cartões (SIM 1 e SIM 2). Guardamos os megas de cada um (estimativa:
// o dono define o saldo e o bot desconta cada entrega). Envia sempre pelo cartão com MAIS megas.
const cartoesDe = (a) => {
  a.cartoes ||= { 1: { ligado: true, mb: null, semMegas: false }, 2: { ligado: true, mb: null, semMegas: false } };
  return a.cartoes;
};
const usavel = (a, k) => { const c = cartoesDe(a)[k]; return online(a) && !a.pausado && c.ligado && !c.semMegas; };
// melhor cartão: o que tem mais megas conhecidos; cartões com saldo desconhecido ficam depois, pela ordem
function melhorCartao(precisa = 0) {
  const L = [];
  for (const [id, a] of ordenadas()) for (const k of [1, 2]) if (usavel(a, k)) L.push({ id, k, mb: cartoesDe(a)[k].mb, ordem: a.ordem || 99 });
  const comSaldo = L.filter((x) => x.mb != null && x.mb >= Math.max(precisa, 1)).sort((x, y) => y.mb - x.mb);
  const semInfo = L.filter((x) => x.mb == null).sort((x, y) => x.ordem - y.ordem || x.k - y.k);
  return comSaldo[0] || semInfo[0] || null;
}
const usados = new Map(); // pedidoId -> { id, k, mb }
const avisadoBaixo = {};
export const mbTexto = (mb) => (mb == null ? '?' : mb >= 1024 ? (mb / 1024).toFixed(mb % 1024 ? 1 : 0).replace('.', ',') + ' GB' : mb + ' MB');
// Lista para o painel / comandos
export function listaCelulares() {
  const m = melhorCartao();
  return ordenadas().map(([id, a]) => {
    const cs = cartoesDe(a);
    const esp = a.pedidoSaldo && a.pedidoSaldo.ate > Date.now() ? a.pedidoSaldo.k : 0;
    const cartoes = [1, 2].map((k) => ({ k, ligado: cs[k].ligado, mb: cs[k].mb, semMegas: cs[k].semMegas, ativo: m?.id === id && m?.k === k, esperaSms: esp === k, atualizado: cs[k].atualizado || 0,
      estado: !cs[k].ligado ? 'Desligado' : cs[k].semMegas ? 'Sem megas' : m?.id === id && m?.k === k ? 'A enviar' : 'Em espera' }));
    const total = cartoes.reduce((t, c) => t + (c.ligado && !c.semMegas && c.mb ? c.mb : 0), 0);
    return { id, ordem: a.ordem, dispositivo: a.dispositivo || '', online: Boolean(online(a)), ativo: m?.id === id,
      estado: a.pausado ? 'Pausado' : !online(a) ? 'Desligado' : m?.id === id ? 'A enviar' : cartoes.every((c) => !c.ligado || c.semMegas) ? 'Sem megas' : 'Em espera',
      cartoes, total, ok: a.ok || 0, falhas: a.falhas || 0, ultimo: a.ultimo || '', ultimoSaldoSms: a.ultimoSaldoSms || null };
  });
}
const achar = (x) => Object.entries(apps).find(([id, a]) => id === x || String(a.ordem) === String(x));
// acao: reativar | pausar | remover
export async function alterarCelular(ordemOuId, acao) {
  await carregar();
  const e = achar(ordemOuId);
  if (!e) return false;
  const [id, a] = e;
  if (acao === 'remover') { delete apps[id]; ordenadas().forEach(([, x], i) => (x.ordem = i + 1)); }
  else if (acao === 'pausar') a.pausado = true;
  else { a.pausado = false; for (const c of Object.values(cartoesDe(a))) c.semMegas = false; }
  await guardar(); acordarFila();
  return true;
}
// acao: ligar | desligar | saldo (mb)
export async function alterarCartao(ordemOuId, k, acao, mb) {
  await carregar();
  const e = achar(ordemOuId);
  if (!e || ![1, 2].includes(Number(k))) return false;
  const c = cartoesDe(e[1])[Number(k)];
  if (acao === 'desligar') c.ligado = false;
  else if (acao === 'ligar') { c.ligado = true; c.semMegas = false; }
  else if (acao === 'saldo') { c.mb = mb; c.semMegas = mb <= 0; c.ligado = true; delete avisadoBaixo[e[0] + k]; }
  await guardar(); acordarFila();
  return true;
}

// ---- Saldo automático pelo SMS do *100# (e "Recebeste N MB do ...") ----
const num = (v, u) => { const x = parseFloat(String(v).replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); return Math.round(/g/i.test(u || '') ? x * 1024 : x); };
export function lerSaldoSms(t) {
  const s = String(t || '').toLowerCase();
  const r = s.match(/recebeste\s+([\d.,]+)\s*(mb|gb)\s+do\s/);
  if (r) return { tipo: 'recebido', mb: num(r[1], r[2]) };
  const m = s.match(/mensal\s*:\s*([\d.,]+)\s*(mb|gb)/) || s.match(/internet\s*:\s*([\d.,]+)\s*(mb|gb)/)
    || s.match(/tens um total de\s*([\d.,]+)\s*(mb|gb)/) || s.match(/(?:dados|megas)\s*:?\s*([\d.,]+)\s*(mb|gb)/);
  if (m && /saldo|internet|mensal|total|dados|megas/.test(s)) return { tipo: 'saldo', mb: num(m[1], m[2]) };
  return null;
}
const PEDIDO_MS = 10 * 60_000;
// Qual cartão recebe o SMS? O que o dono escolheu no botão "Atualizar" (10 min), ou o único cartão ligado.
function cartaoDoSms(a) {
  if (a.pedidoSaldo && a.pedidoSaldo.ate > Date.now()) return a.pedidoSaldo.k;
  const lig = [1, 2].filter((k) => cartoesDe(a)[k].ligado);
  return lig.length === 1 ? lig[0] : null;
}
function aplicarSaldo(a, id, k, info) {
  const c = cartoesDe(a)[k];
  if (info.tipo === 'recebido') c.mb = c.mb == null ? null : c.mb + info.mb;
  else c.mb = info.mb;
  if (c.mb != null) { c.semMegas = c.mb <= 0; delete avisadoBaixo[id + k]; }
  c.atualizado = Date.now();
}
// Botão "Atualizar" do painel: espera o SMS do *100# para este cartão (ou usa um que acabou de chegar)
export async function pedirSaldo(ordemOuId, k) {
  await carregar();
  const e = achar(ordemOuId);
  if (!e || ![1, 2].includes(Number(k))) return false;
  const [id, a] = e;
  k = Number(k);
  const u = a.ultimoSaldoSms;
  if (u && u.tipo === 'saldo' && !u.aplicado && Date.now() - u.quando < PEDIDO_MS) { aplicarSaldo(a, id, k, u); u.aplicado = k; delete a.pedidoSaldo; }
  else a.pedidoSaldo = { k, ate: Date.now() + PEDIDO_MS };
  await guardar(); acordarFila();
  return true;
}

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

export function montarGeator(app, { avisar, avisarDono = async () => {} }) {
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
      const dispositivo = String(req.body?.dispositivo || '').slice(0, 60);
      const ordem = Math.max(0, ...Object.values(apps).map((a) => a.ordem || 0)) + 1;
      apps[appId] = { token, dispositivo, criado: Date.now(), ordem, visto: Date.now() };
      await guardar();
      avisarDono(`📲 Celular ${ordem} ligado à app GEATOR${dispositivo ? ' (' + dispositivo + ')' : ''}. Total: ${Object.keys(apps).length} celular(es).`).catch(() => {});
      res.json({ ok: true, tenantId: SESSAO, token, appId, telefoneNumero: ordem, sims: SIMS });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
  });

  api.post('/app/heartbeat', auth, (req, res) => {
    const id = req.get('x-geator-app-id');
    if (req.body?.dispositivo) apps[id].dispositivo = String(req.body.dispositivo).slice(0, 60);
    res.json({ ok: true, app: { telefoneNumero: apps[id].ordem || 1, sims: SIMS, estado: 'online' } });
  });

  api.get('/protocolo', auth, (_q, res) => res.json({ ok: true, protocolo: 'geator-rent', servidor: 'FAST SHOP 24H' }));

  api.get('/pedidos/proximo', auth, async (req, res) => {
    const best = melhorCartao();
    if (!best || req.get('x-geator-app-id') !== best.id) return res.json({ ok: true, pedido: null }); // só o celular com o melhor cartão envia
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
      let k = best.k;
      const c = melhorCartao(p.mb);
      if (c && c.id === best.id) k = c.k;
      usados.set(String(p.id), { id: best.id, k, mb: p.mb });
      geatorEstado.ultimo = `#${p.id} ${p.mb}MB → ${p.numero} (Celular ${apps[best.id]?.ordem || 1}, cartão ${k})`;
      res.json({ ok: true, pedido: { id: String(p.id), numero: p.numero, mb: p.mb, simSlot: k,
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
      const id = req.get('x-geator-app-id');
      const a = apps[id];
      const r = await rpc('geator_resultado', { p_id: Number(req.params.id), p_ok: ok, p_msg: msg });
      res.json({ ok: true });
      const u = usados.get(String(req.params.id)) || { id, k: Number(b.simSlot) === 2 ? 2 : 1, mb: r?.mb || 0 };
      usados.delete(String(req.params.id));
      const cart = cartoesDe(a)[u.k];
      if (ok) {
        a.ok = (a.ok || 0) + 1; a.ultimo = '✅ ' + (r?.mb || '') + 'MB → ' + (r?.numero || '') + ' (cartão ' + u.k + ')';
        if (cart.mb != null) {
          cart.mb = Math.max(0, cart.mb - (u.mb || 0));
          if (cart.mb < 1024 && !avisadoBaixo[id + u.k]) { avisadoBaixo[id + u.k] = 1; avisarDono(`🔋 Celular ${a.ordem}, cartão ${u.k}: restam só ~${mbTexto(cart.mb)}.\nQuando recarregares: !saldo ${a.ordem} ${u.k} 10GB`).catch(() => {}); }
        }
      }
      else { a.falhas = (a.falhas || 0) + 1; a.ultimo = '❌ ' + msg.slice(0, 60); }
      if (!ok && (SEM_MEGAS.test(msg) || /saldo_insuficiente/i.test(b.codigo || '')) && r?.id) {
        // Celular sem megas → pausa-o e passa a entrega para o próximo celular
        cart.semMegas = true; cart.mb = 0;
        await guardar().catch(() => {});
        await rpc('geator_repetir', { p_id: r.id }).catch(() => {});
        avisarDono((() => { const pb = melhorCartao(r.mb) || melhorCartao(); return `🔁 Celular ${a.ordem}, cartão ${u.k} ficou sem megas.\n` + (pb ? `A entrega #${r.id} passou para o Celular ${apps[pb.id].ordem}, cartão ${pb.k}.` : `⚠️ Nenhum outro cartão com megas — a entrega #${r.id} fica à espera.`) + `\n\nQuando recarregares: !saldo ${a.ordem} ${u.k} 10GB`; })()).catch(() => {});
        acordarFila();
        return;
      }
      guardar().catch(() => {});
      acordarFila();
      if (r?.id) avisar(r, ok, msg).catch((e) => console.error('geator aviso', e.message));
    } catch (e) { res.json({ ok: false, erro: e.message }); }
  });

  api.post('/sms', auth, async (req, res) => {
    try {
      const texto = String(req.body?.texto || '');
      const de = String(req.body?.origemSms || '');
      const info = lerSaldoSms(texto);
      if (info) {
        const id = req.get('x-geator-app-id'); const a = apps[id];
        const k = cartaoDoSms(a);
        a.ultimoSaldoSms = { ...info, quando: Date.now(), aplicado: 0 };
        if (k) { aplicarSaldo(a, id, k, info); a.ultimoSaldoSms.aplicado = k; if (info.tipo === 'saldo') delete a.pedidoSaldo; }
        await guardar().catch(() => {}); acordarFila();
        avisarDono(k ? `📊 Celular ${a.ordem}, cartão ${k}: ${info.tipo === 'recebido' ? '+' + mbTexto(info.mb) + ' recebidos → ' : ''}agora ~${mbTexto(cartoesDe(a)[k].mb)} (pelo SMS).`
          : `📊 Celular ${a.ordem} recebeu SMS de ${info.tipo === 'recebido' ? '+' : ''}${mbTexto(info.mb)}, mas tem 2 cartões. No painel carrega em "Atualizar" no cartão certo.`).catch(() => {});
      }
      if (/recebe|received|confirmad/i.test(texto) && texto.length >= 10) await rpc('bot_ingest_sms', { p_text: texto, p_sender: de });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, erro: e.message }); }
  });

  api.post('/executor/controle/:id', auth, (_q, res) => res.json({ ok: true }));
  app.use('/api/rent', api);
}
