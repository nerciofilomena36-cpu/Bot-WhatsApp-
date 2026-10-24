// FAST SHOP 24H — Bot WhatsApp
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import { useSupabaseAuthState } from './auth.js';
import { rpc, configOk } from './db.js';
import { responder, ehHumanoPedido } from './logic.js';

const PORT = process.env.PORT || 3000;
const PAINEL_SENHA = process.env.PAINEL_SENHA || '';
const log = pino({ level: 'silent' });

const st = { estado: 'A iniciar', qr: null, codigo: null, numero: null, erro: null, enviados: 0, respostas: 0 };
let sock = null;
let pedirCodigo = null; // número para código de emparelhamento
const pausa = new Map(); // jid -> até quando o bot fica calado (suporte humano / dono respondeu)
const ultimaResp = new Map(); // anti-spam
// Grupos onde o bot pode responder (vazio = todos). Ex.: BOT_GRUPOS=1203630xxxx@g.us,1203631yyyy@g.us
const GRUPOS = (process.env.BOT_GRUPOS || '').split(',').map((x) => x.trim()).filter(Boolean);

async function iniciar() {
  if (!configOk()) { st.estado = 'Falta configurar SUPABASE_URL, SUPABASE_ANON_KEY e BOT_SECRET'; return; }
  if (sock) { try { sock.end(undefined); } catch {} sock = null; }
  const { state, saveCreds, reset } = await useSupabaseAuthState();
  let version;
  try { version = (await fetchLatestBaileysVersion()).version; } catch {}
  const s = makeWASocket({ auth: state, logger: log, version, browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false });
  sock = s;
  st.estado = 'A ligar';

  s.ev.on('creds.update', () => saveCreds().catch((e) => (st.erro = e.message)));
  s.ev.on('connection.update', async (u) => {
    if (sock !== s) return;
    if (u.qr) {
      st.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 300 });
      st.estado = 'Aguarda ligação';
      if (pedirCodigo && !s.authState.creds.registered) {
        try { st.codigo = await s.requestPairingCode(pedirCodigo); } catch (e) { st.erro = e.message; }
        pedirCodigo = null;
      }
    }
    if (u.connection === 'open') {
      st.estado = 'Conectado'; st.qr = null; st.codigo = null; st.erro = null;
      st.numero = (s.user?.id || '').split(':')[0].split('@')[0];
      console.log('WhatsApp conectado', st.numero);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        st.estado = 'Sessão terminada — liga de novo'; st.numero = null;
        await reset().catch(() => {});
      } else st.estado = 'A religar';
      setTimeout(() => { if (sock === s) iniciar().catch((e) => (st.erro = e.message)); }, 4000);
    }
  });

  s.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        const jid = m.key.remoteJid || '';
        if (!m.message || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        const grupo = jid.endsWith('@g.us');
        if (grupo && GRUPOS.length && !GRUPOS.includes(jid)) continue;
        const msg = m.message;
        const texto = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
        if (m.key.id?.startsWith('BOT')) continue; // mensagens do próprio bot
        if (m.key.fromMe) {
          // Privado: se tu (dono) responderes à mão, o bot fica calado 2 h com essa pessoa
          if (!grupo) { pausa.set(jid, Date.now() + 2 * 3600_000); continue; }
        }
        if (!texto.trim()) continue;
        const sempre = /FS24-\d{8}-[A-Z0-9]{4}/i.test(texto) || /^\s*[1-5]\s*$/.test(texto);
        if (!grupo && (pausa.get(jid) || 0) > Date.now() && !sempre) continue;
        const quem = grupo ? (m.key.participant || jid) : jid;
        if (Date.now() - (ultimaResp.get(quem) || 0) < 1500) continue;
        const ctx = msg.extendedTextMessage?.contextInfo || msg.imageMessage?.contextInfo || {};
        const meus = [s.user?.id, s.user?.lid].filter(Boolean).map((x) => x.split(':')[0].split('@')[0]);
        const mencionado = grupo && [...(ctx.mentionedJid || []), ctx.participant || ''].some((x) => meus.includes(String(x).split(':')[0].split('@')[0]));
        const phone = (grupo ? (m.key.participantPn || m.key.participant || '') : (m.key.senderPn || jid)).split('@')[0].split(':')[0];
        const resposta = await responder(texto, phone, (m.pushName || '').split(' ')[0], { grupo, mencionado, botNumero: st.numero });
        if (resposta) {
          ultimaResp.set(quem, Date.now());
          if (!grupo) await s.sendPresenceUpdate('composing', jid).catch(() => {});
          await s.sendMessage(jid, { text: resposta }, { quoted: grupo ? m : undefined, messageId: 'BOT' + Date.now().toString(16).toUpperCase() });
          st.respostas++;
        }
        if (!grupo && ehHumanoPedido(texto)) pausa.set(jid, Date.now() + 2 * 3600_000);
      } catch (e) { console.error('msg', e.message); }
    }
  });
}

// Envia avisos de pedidos (recebido / pago / enviado / entregue / cancelado)
async function enviarFila() {
  if (st.estado !== 'Conectado' || !sock) return;
  try {
    const fila = await rpc('bot_pull_outbox');
    for (const it of fila || []) {
      let ok = false;
      try {
        const [r] = await sock.onWhatsApp(it.phone);
        if (r?.exists) {
          await sock.sendMessage(r.jid, { text: it.body }, { messageId: 'BOT' + Date.now().toString(16).toUpperCase() });
          ok = true; st.enviados++;
        }
      } catch (e) { console.error('fila', e.message); }
      await rpc('bot_ack_outbox', { p_id: it.id, p_ok: ok }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e) { st.erro = e.message; }
}
setInterval(enviarFila, 10_000);

// ---------- Painel simples ----------
const app = express();
app.use(express.urlencoded({ extended: false }));
const autorizado = (req) => !PAINEL_SENHA || req.query.senha === PAINEL_SENHA || req.body?.senha === PAINEL_SENHA;

app.get('/health', (_q, r) => r.json({ ok: true, estado: st.estado }));
app.get('/', (req, res) => {
  if (!autorizado(req)) return res.status(401).send('<form style="font-family:sans-serif;padding:30px"><h3>FAST SHOP Bot</h3><input name="senha" type="password" placeholder="Senha do painel"> <button>Entrar</button></form>');
  const q = PAINEL_SENHA ? `?senha=${encodeURIComponent(req.query.senha || '')}` : '';
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="8">
<body style="font-family:sans-serif;max-width:480px;margin:auto;padding:20px;background:#fff7f0">
<h2 style="color:#FF6A00">⚡ FAST SHOP 24H — Bot WhatsApp</h2>
<p>Estado: <b>${st.estado}</b>${st.numero ? ` (${st.numero})` : ''}</p>
<p>Respostas: ${st.respostas} · Avisos enviados: ${st.enviados}</p>
${st.erro ? `<p style="color:#b00">Erro: ${st.erro}</p>` : ''}
${st.codigo ? `<h3>Código de ligação: <span style="font-size:32px;letter-spacing:4px">${st.codigo}</span></h3><p>No telemóvel do bot: WhatsApp › Dispositivos ligados › Ligar dispositivo › <b>Ligar com número de telefone</b> e escreve este código.</p>` : ''}
${st.estado !== 'Conectado' ? `
<form method="post" action="/codigo${q}"><input type="hidden" name="senha" value="${req.query.senha || ''}">
<p>Ligar pelo próprio telemóvel (sem QR): número do WhatsApp do bot</p>
<input name="numero" value="258848033355" style="padding:8px"> <button style="padding:8px">Gerar código</button></form>
${st.qr ? `<p>Ou lê este QR noutro telemóvel/ecrã:</p><img src="${st.qr}" width="260">` : ''}` : `
<form method="post" action="/sair${q}"><input type="hidden" name="senha" value="${req.query.senha || ''}"><button>Desligar WhatsApp</button></form>`}
</body>`);
});
app.post('/codigo', async (req, res) => {
  if (!autorizado(req)) return res.sendStatus(401);
  pedirCodigo = String(req.body.numero || '').replace(/\D/g, '');
  if (pedirCodigo.length === 9) pedirCodigo = '258' + pedirCodigo;
  st.codigo = null;
  await iniciar().catch((e) => (st.erro = e.message));
  setTimeout(() => res.redirect('/' + (PAINEL_SENHA ? `?senha=${encodeURIComponent(req.body.senha || '')}` : '')), 5000);
});
app.post('/sair', async (req, res) => {
  if (!autorizado(req)) return res.sendStatus(401);
  try { await sock?.logout(); } catch {}
  res.redirect('/' + (PAINEL_SENHA ? `?senha=${encodeURIComponent(req.body.senha || '')}` : ''));
});

app.listen(PORT, () => console.log('Painel na porta', PORT));
iniciar().catch((e) => { st.erro = e.message; console.error(e); });

// Mantém o serviço acordado em hospedagens grátis (ex.: Render)
const SELF = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
if (SELF) setInterval(() => fetch(`${SELF}/health`).catch(() => {}), 10 * 60_000);
