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

// Números do bot (o 1º é o principal; os avisos de pedidos saem por ele). Editável no Render: BOT_NUMEROS
const NUMEROS = (process.env.BOT_NUMEROS || '258848033355,258842286799').split(',').map((x) => x.replace(/\D/g, '')).filter(Boolean)
  .map((n) => (n.length === 9 ? '258' + n : n));
// Tabela de preços fixa do 2º número (842286799)
const TABELA_2 = "*📶 PACOTES DIÁRIOS – 24 HORAS*\n🔹️ *400MB - 10MT*\n🔹*512 MB — 12MT*\n🔹*850 MB — 20 MT*\n🔹*1 GB — 23 MT*\n🔹*1,2 GB — 28 MT 🆕*\n🔹*1,6 GB — 38 MT 🆕*\n🔹*2 GB — 46 MT*\n🔹*2,5 GB — 60 MT 🆕*\n🔹*3 GB —69  MT*\n🔹*4 GB — 92 MT*\n🔹*5 GB — 115 MT*\n🔹*10 GB — 230 MT 🆕*\n\n━━━━━━━━━━━━━━\n\n*📅 PACOTES SEMANAIS – VALIDADE: 7 DIAS*\n\n🌐 *1,7 GB — 50MT*\n🌐 *2,9 GB — 85 MT*\n🌐 *3,4 GB — 105 MT*\n🌐 *5,2 GB — 155 MT*\n🌐*7,1 GB — 195 MT*\n\n━━━━━━━━━━━━━━\n\n*📆 PACOTES MENSAIS – VALIDADE: 30 DIAS*\n🔸️  *2,8GB - 95 MT*\n🔸️ *3, 2GB - 120MT*\n🔸 *4 GB — 140MT*\n🔸*5 GB — 154 MT*\n🔸*10 GB — 280 MT*\n🔸*15 GB — 395 MT*\n\n*⚠️ NOTA IMPORTANTE:*\n*❌ Para ativar os pacotes mensais, a linha não pode ter Txuna.*";
const TABELAS = [null, TABELA_2];
// Formas de pagamento próprias do 2º número
const PAGAMENTO_2 = "💳 *FORMAS DE PAGAMENTO* 🇲🇿\n\n📱 *M-Pesa: 852562445*\n👤 *MAURICIO JORGE MUHOLOVE*\n\n📲 *e-Mola: 876028401*\n👤 *MAURICIO JORGE MUHOLOVE*\n\n🏦 *BIM:* *1248240524*\n👤 *MAURICIO JORGE MUHOLOVE*";
const PAGAMENTOS = [null, PAGAMENTO_2];
const SESSOES = NUMEROS.map((num, i) => ({
  id: i === 0 ? '' : `s${i + 1}:`, // prefixo das chaves no Supabase ('' = sessão antiga, continua ligada)
  nome: i === 0 ? 'Número principal' : `Número ${i + 1}`,
  padrao: num,
  pagamento: PAGAMENTOS[i] || null, // pagamento próprio (null = do Supabase)
  tabela: TABELAS[i] || null, // tabela de preços própria deste número (null = tabela do site)
  sock: null,
  pedirCodigo: null,
  grupos: new Set(),
  st: { estado: 'A iniciar', qr: null, codigo: null, numero: null, erro: null, enviados: 0, respostas: 0 },
}));
const pausa = new Map(); // sessão+jid -> até quando o bot fica calado (suporte humano / dono respondeu)
const ultimaResp = new Map(); // anti-spam
// Grupos: o bot só responde nos grupos ATIVADOS. Para ativar, o dono escreve !ativarbot dentro do grupo
// (com o WhatsApp desse número). Para desligar: !desativarbot. Fica guardado no Supabase.
const GRUPOS_ENV = (process.env.BOT_GRUPOS || '').split(',').map((x) => x.trim()).filter((x) => x.endsWith('@g.us'));
async function carregaGrupos(S) {
  try { const r = await rpc('bot_auth_get', { p_keys: [S.id + 'cfg-grupos'] }); S.grupos = new Set(JSON.parse(r?.[S.id + 'cfg-grupos'] || '[]')); }
  catch { S.grupos = S.grupos || new Set(); }
}
const guardaGrupos = (S) => rpc('bot_auth_set', { p_data: { [S.id + 'cfg-grupos']: JSON.stringify([...S.grupos]) } });

async function iniciar(S) {
  const st = S.st;
  if (!configOk()) { st.estado = 'Falta configurar SUPABASE_URL, SUPABASE_ANON_KEY e BOT_SECRET'; return; }
  if (S.sock) { try { S.sock.end(undefined); } catch {} S.sock = null; }
  const { state, saveCreds, reset } = await useSupabaseAuthState(S.id);
  await carregaGrupos(S);
  let version;
  try { version = (await fetchLatestBaileysVersion()).version; } catch {}
  const s = makeWASocket({ auth: state, logger: log, version, browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false });
  S.sock = s;
  st.estado = 'A ligar';

  s.ev.on('creds.update', () => saveCreds().catch((e) => (st.erro = e.message)));
  s.ev.on('connection.update', async (u) => {
    if (S.sock !== s) return;
    if (u.qr) {
      st.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 300 });
      st.estado = 'Aguarda ligação';
      if (S.pedirCodigo && !s.authState.creds.registered) {
        try { st.codigo = await s.requestPairingCode(S.pedirCodigo); } catch (e) { st.erro = e.message; }
        S.pedirCodigo = null;
      }
    }
    if (u.connection === 'open') {
      st.estado = 'Conectado'; st.qr = null; st.codigo = null; st.erro = null;
      st.numero = (s.user?.id || '').split(':')[0].split('@')[0];
      console.log('WhatsApp conectado', st.numero);
      const lerGrupos = () => s.groupFetchAllParticipating().then((r) => { S.listaGrupos = Object.values(r).map((g) => ({ id: g.id, subject: g.subject })).sort((a, b) => String(a.subject).localeCompare(String(b.subject))); }).catch(() => {});
      setTimeout(lerGrupos, 3000); clearInterval(S.tGrupos); S.tGrupos = setInterval(lerGrupos, 10 * 60_000);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        st.estado = 'Sessão terminada — liga de novo'; st.numero = null;
        await reset().catch(() => {});
        if (!S.pedirCodigo) { S.sock = null; return; } // espera por "Gerar código"
      } else st.estado = 'A religar';
      setTimeout(() => { if (S.sock === s) iniciar(S).catch((e) => (st.erro = e.message)); }, 4000);
    }
  });

  s.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      if (type !== 'notify' && !m.key?.fromMe) continue; // mensagens do dono podem vir como 'append'
      try {
        const jid = m.key.remoteJid || '';
        if (!m.message || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        const grupo = jid.endsWith('@g.us');
        if (grupo && m.key.fromMe && !m.key.id?.startsWith('BOT')) {
          const cmd = (msg.conversation || msg.extendedTextMessage?.text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
          if (cmd === 'ativarbot' || cmd === 'desativarbot') {
            if (cmd === 'ativarbot') S.grupos.add(jid); else S.grupos.delete(jid);
            await guardaGrupos(S).catch((e) => console.error('grupos', e.message));
            console.log('grupo', cmd, jid);
            await s.sendMessage(jid, { text: cmd === 'ativarbot' ? '✅ Bot ativado neste grupo.' : '⛔ Bot desativado neste grupo.' }, { messageId: 'BOT' + Date.now().toString(16).toUpperCase() });
            continue;
          }
        }
        if (type !== 'notify') continue;
        if (grupo && !S.grupos.has(jid) && !GRUPOS_ENV.includes(jid)) continue;
        const msg = m.message;
        const texto = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
        if (m.key.id?.startsWith('BOT')) continue; // mensagens do próprio bot
        if (m.key.fromMe) {
          // Privado: se tu (dono) responderes à mão, o bot fica calado 2 h com essa pessoa
          if (!grupo) { pausa.set(S.id + jid, Date.now() + 2 * 3600_000); continue; }
        }
        if (!texto.trim()) continue;
        const sempre = /FS24-\d{8}-[A-Z0-9]{4}/i.test(texto) || /^\s*[1-5]\s*$/.test(texto);
        if (!grupo && (pausa.get(S.id + jid) || 0) > Date.now() && !sempre) continue;
        const quem = S.id + (grupo ? (m.key.participant || jid) : jid);
        if (Date.now() - (ultimaResp.get(quem) || 0) < 1500) continue;
        const ctx = msg.extendedTextMessage?.contextInfo || msg.imageMessage?.contextInfo || {};
        const meus = [s.user?.id, s.user?.lid].filter(Boolean).map((x) => x.split(':')[0].split('@')[0]);
        const mencionado = grupo && [...(ctx.mentionedJid || []), ctx.participant || ''].some((x) => meus.includes(String(x).split(':')[0].split('@')[0]));
        const phone = (grupo ? (m.key.participantPn || m.key.participant || '') : (m.key.senderPn || jid)).split('@')[0].split(':')[0];
        const resposta = await responder(texto, phone, (m.pushName || '').split(' ')[0], { grupo, mencionado, botNumero: S.st.numero, tabela: S.tabela, pagamento: S.pagamento });
        if (resposta) {
          ultimaResp.set(quem, Date.now());
          if (!grupo) await s.sendPresenceUpdate('composing', jid).catch(() => {});
          await s.sendMessage(jid, { text: resposta }, { quoted: grupo ? m : undefined, messageId: 'BOT' + Date.now().toString(16).toUpperCase() });
          S.st.respostas++;
        }
        if (!grupo && ehHumanoPedido(texto)) pausa.set(S.id + jid, Date.now() + 2 * 3600_000);
      } catch (e) { console.error('msg', e.message); }
    }
  });
}

// Envia avisos de pedidos (recebido / pago / enviado / entregue / cancelado) pelo 1º número ligado
async function enviarFila() {
  const S = SESSOES.find((x) => x.st.estado === 'Conectado' && x.sock);
  if (!S) return;
  const sock = S.sock;
  try {
    const fila = await rpc('bot_pull_outbox');
    for (const it of fila || []) {
      let ok = false;
      try {
        const [r] = await sock.onWhatsApp(it.phone);
        if (r?.exists) {
          await sock.sendMessage(r.jid, { text: it.body }, { messageId: 'BOT' + Date.now().toString(16).toUpperCase() });
          ok = true; S.st.enviados++;
        }
      } catch (e) { console.error('fila', e.message); }
      await rpc('bot_ack_outbox', { p_id: it.id, p_ok: ok }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e) { S.st.erro = e.message; }
}
setInterval(enviarFila, 10_000);

// ---------- Painel simples ----------
const app = express();
app.use(express.urlencoded({ extended: false }));
const autorizado = (req) => !PAINEL_SENHA || req.query.senha === PAINEL_SENHA || req.body?.senha === PAINEL_SENHA;

app.get('/health', (_q, r) => r.json({ ok: true, estado: SESSOES[0].st.estado, numeros: SESSOES.map((S) => ({ numero: S.st.numero || S.padrao, estado: S.st.estado })) }));
app.get('/', (req, res) => {
  if (!autorizado(req)) return res.status(401).send('<form style="font-family:sans-serif;padding:30px"><h3>FAST SHOP Bot</h3><input name="senha" type="password" placeholder="Senha do painel"> <button>Entrar</button></form>');
  const q = PAINEL_SENHA ? `?senha=${encodeURIComponent(req.query.senha || '')}` : '';
  const h = `<input type="hidden" name="senha" value="${req.query.senha || ''}">`;
  const blocos = SESSOES.map((S, i) => { const st = S.st; return `
<div style="background:#fff;border-radius:12px;padding:14px;margin:14px 0;box-shadow:0 1px 4px #0002">
<h3 style="margin:0 0 6px">📱 ${S.nome}: ${st.numero || S.padrao}</h3>
<p>Estado: <b>${st.estado}</b> · Respostas: ${st.respostas}${i === 0 ? ` · Avisos enviados: ${SESSOES.reduce((a, x) => a + x.st.enviados, 0)}` : ''}</p>
${st.erro ? `<p style="color:#b00">Erro: ${st.erro}</p>` : ''}
${st.codigo ? `<h3>Código de ligação: <span style="font-size:32px;letter-spacing:4px">${st.codigo}</span></h3><p>No telemóvel <b>${S.padrao}</b>: WhatsApp › Dispositivos ligados › Ligar dispositivo › <b>Ligar com número de telefone</b> e escreve este código.</p>` : ''}
${st.estado !== 'Conectado' ? `
<form method="post" action="/codigo${q}">${h}<input type="hidden" name="s" value="${i}">
<input name="numero" value="${S.padrao}" style="padding:8px"> <button style="padding:8px">Gerar código</button></form>
${st.qr ? `<p>Ou lê este QR noutro telemóvel/ecrã:</p><img src="${st.qr}" width="220">` : ''}` : `
<p><b>Grupos</b> (o bot só responde nos ativados):</p>
${(S.listaGrupos || []).map((g) => `<form method="post" action="/grupo${q}" style="margin:4px 0">${h}<input type="hidden" name="s" value="${i}"><input type="hidden" name="g" value="${g.id}">
${S.grupos.has(g.id) ? '✅' : '⬜'} ${String(g.subject || g.id).replace(/[<>&"]/g, '')} <button style="padding:4px 8px">${S.grupos.has(g.id) ? 'Desativar' : 'Ativar'}</button></form>`).join('') || '<p>(a carregar grupos…)</p>'}
<form method="post" action="/sair${q}" style="margin-top:12px">${h}<input type="hidden" name="s" value="${i}"><button>Desligar este número</button></form>`}
</div>`; }).join('');
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="8">
<body style="font-family:sans-serif;max-width:480px;margin:auto;padding:20px;background:#fff7f0">
<h2 style="color:#FF6A00">⚡ FAST SHOP 24H — Bot WhatsApp</h2>${blocos}
</body>`);
});
const volta = (req, res) => res.redirect('/' + (PAINEL_SENHA ? `?senha=${encodeURIComponent(req.body.senha || '')}` : ''));
app.post('/codigo', async (req, res) => {
  if (!autorizado(req)) return res.sendStatus(401);
  const S = SESSOES[Number(req.body.s) || 0] || SESSOES[0];
  S.pedirCodigo = String(req.body.numero || '').replace(/\D/g, '');
  if (S.pedirCodigo.length === 9) S.pedirCodigo = '258' + S.pedirCodigo;
  S.st.codigo = null;
  await iniciar(S).catch((e) => (S.st.erro = e.message));
  setTimeout(() => volta(req, res), 5000);
});
app.post('/grupo', async (req, res) => {
  if (!autorizado(req)) return res.sendStatus(401);
  const S = SESSOES[Number(req.body.s) || 0] || SESSOES[0];
  const g = String(req.body.g || '');
  if (g.endsWith('@g.us')) {
    if (S.grupos.has(g)) S.grupos.delete(g); else S.grupos.add(g);
    await guardaGrupos(S).catch((e) => (S.st.erro = e.message));
  }
  volta(req, res);
});
app.post('/sair', async (req, res) => {
  if (!autorizado(req)) return res.sendStatus(401);
  const S = SESSOES[Number(req.body.s) || 0] || SESSOES[0];
  try { await S.sock?.logout(); } catch {}
  volta(req, res);
});

app.listen(PORT, () => console.log('Painel na porta', PORT));
// Liga cada número (o principal já tem sessão; os novos esperam por "Gerar código")
for (const S of SESSOES) {
  useSupabaseAuthState(S.id).then(({ state }) => {
    if (S.id === '' || state.creds.registered) return iniciar(S);
    S.st.estado = 'Por ligar — carrega em Gerar código';
  }).catch((e) => { S.st.erro = e.message; console.error(e); });
}

// Mantém o serviço acordado em hospedagens grátis (ex.: Render)
const SELF = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
if (SELF) setInterval(() => fetch(`${SELF}/health`).catch(() => {}), 10 * 60_000);
