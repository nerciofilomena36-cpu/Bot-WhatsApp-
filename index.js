// FAST SHOP 24H — Bot WhatsApp
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import { useSupabaseAuthState } from './auth.js';
import { rpc, configOk } from './db.js';
import { responder, ehHumanoPedido } from './logic.js';
import { montarGeator, novoCodigo, paraMB, acordarFila, geatorEstado } from './geator.js';

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
// Pagamento mostrado NOS GRUPOS ativados do número principal (848033355)
const PAGAMENTO_GRUPO_1 = "📩 COMO FAZER O PEDIDO\n\n1️⃣ Envie o texto da transferência\n2️⃣ Informe o número da Vodacom que irá receber o pacote.\n\n💳 PAGAMENTOS\n\n📱 M-Pesa - 848033355\n👤 Nercio \n\n📱 e-Mola - 869875020\n👤 Nercio Filomena \n\n\n⚠️ IMPORTANTE\n\n• Para saldo envia o valor no mpesa.\n• Envie apenas valores que constam na tabela\n• Transferências SIMO não são aceites";
const PAGAMENTOS_GRUPO = [PAGAMENTO_GRUPO_1, null];
// Tabela própria de um grupo específico, pelo código do link de convite (chat.whatsapp.com/CODIGO)
const TABELAS_POR_LINK = {
  FGCCPaw34WPDkvGkLjyccm: "*🌐 TABELA DE NET/ SALDO 📱*\n\n\n- 🛜10GB🌐 = 180MT\n\n\n- 🛜5GB🌐 = 100MT\n\n\n- ☎️50📱 = 45MT\n\n\n- ☎️100📱 = 90MT\n\n- ☎️500📱= 420MT\n\n\n- ☎️1000📱 = 815MT\n\n- Acima de 3k-810\n\n\n\n✅Confiança é tudo!",
};
const tabelaPorGrupo = new Map(); // jid do grupo -> tabela
async function resolveLinks(s) {
  for (const [cod, tab] of Object.entries(TABELAS_POR_LINK)) {
    if ([...tabelaPorGrupo.values()].includes(tab)) continue;
    try { const g = await s.groupGetInviteInfo(cod); if (g?.id) { tabelaPorGrupo.set(g.id, tab); console.log('tabela do grupo', g.subject, g.id); } }
    catch (e) { console.error('link', cod, e.message); }
  }
}
const SESSOES = NUMEROS.map((num, i) => ({
  id: i === 0 ? '' : `s${i + 1}:`, // prefixo das chaves no Supabase ('' = sessão antiga, continua ligada)
  nome: i === 0 ? 'Número principal' : `Número ${i + 1}`,
  padrao: num,
  pagamento: PAGAMENTOS[i] || null,
  pagamentoGrupo: PAGAMENTOS_GRUPO[i] || null, // pagamento próprio (null = do Supabase)
  tabela: TABELAS[i] || null, // tabela de preços própria deste número (null = tabela do site)
  sock: null,
  pedirCodigo: null,
  grupos: new Set(),
  textos: {}, // textos mudados pelo dono no WhatsApp (!tabela / !pagamento)
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
async function carregaTextos(S) {
  try { const r = await rpc('bot_auth_get', { p_keys: [S.id + 'cfg-textos'] }); S.textos = JSON.parse(r?.[S.id + 'cfg-textos'] || '{}'); }
  catch { S.textos = S.textos || {}; }
}
const guardaTextos = (S) => rpc('bot_auth_set', { p_data: { [S.id + 'cfg-textos']: JSON.stringify(S.textos) } });
const guardaGrupos = (S) => rpc('bot_auth_set', { p_data: { [S.id + 'cfg-grupos']: JSON.stringify([...S.grupos]) } });

async function iniciar(S) {
  const st = S.st;
  if (!configOk()) { st.estado = 'Falta configurar SUPABASE_URL, SUPABASE_ANON_KEY e BOT_SECRET'; return; }
  if (S.sock) { try { S.sock.end(undefined); } catch {} S.sock = null; }
  const { state, saveCreds, reset } = await useSupabaseAuthState(S.id);
  await carregaGrupos(S);
  await carregaTextos(S);
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
      setTimeout(() => { lerGrupos(); resolveLinks(s); }, 3000); clearInterval(S.tGrupos); S.tGrupos = setInterval(lerGrupos, 10 * 60_000);
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
        const msg = m.message;
        if (m.key.fromMe && !m.key.id?.startsWith('BOT')) {
          const bruto = (msg.conversation || msg.extendedTextMessage?.text || '').trim();
          const cmd = bruto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
          const env = (text) => s.sendMessage(jid, { text }, { messageId: 'BOT' + Date.now().toString(16).toUpperCase() });
          if (grupo && (cmd === 'ativarbot' || cmd === 'desativarbot')) {
            if (cmd === 'ativarbot') S.grupos.add(jid); else S.grupos.delete(jid);
            await guardaGrupos(S).catch((e) => console.error('grupos', e.message));
            console.log('grupo', cmd, jid);
            await env(cmd === 'ativarbot' ? '✅ Bot ativado neste grupo.' : '⛔ Bot desativado neste grupo.');
            continue;
          }
          // Comandos do dono para mudar textos SEM mexer no código:
          //   no grupo -> muda só nesse grupo;  na conversa contigo mesmo -> muda o privado deste número
          const meusIds = [s.user?.id, s.user?.lid].filter(Boolean).map((x) => x.split(':')[0].split('@')[0]);
          const proprio = !grupo && meusIds.includes(jid.split('@')[0].split(':')[0]);
          // ---- Entregas automáticas (app GEATOR BOT MOBILE) ----
          if (proprio && /^[!.]\s*pairapp\b/i.test(bruto)) {
            await env(`📲 Código para parear a app GEATOR BOT MOBILE:\n\n*${novoCodigo()}*\n\nNa app: Parear › escreve este código e na URL do GEATOR RENT põe:\n${URL_PUBLICA}\n\n(Válido 15 min, só 1 vez)`);
            continue;
          }
          const me = bruto.match(/^!\s*enviar\s+(\+?[\d ]{9,16}?)\s+(\d+(?:[.,]\d+)?\s*(?:gb|g|mb|m)?)\s*$/i);
          if (me) {
            const num = me[1].replace(/\D/g, '').slice(-9); const mb = paraMB(me[2].replace(/\s/g, ''));
            if (!/^8[45]\d{7}$/.test(num) || mb < 10) { await env('Escreve assim: !enviar 841234567 1024  (ou 1GB). Só números Vodacom 84/85.'); continue; }
            const id = await rpc('geator_adicionar', { p_numero: num, p_mb: mb, p_avisar: proprio ? null : jid, p_pacote: `${mb}MB` });
            acordarFila();
            await env(`📲 Entrega #${id} na fila: *${mb} MB* → *${num}*. A app vai enviar já.`);
            continue;
          }
          if (proprio && cmd === 'entregas') {
            const L = await rpc('geator_lista').catch(() => []);
            const ic = { pendente: '⏳', reservado: '📤', executando: '⚙️', entregue: '✅', falhou: '❌' };
            await env('📦 Últimas entregas\n\n' + ((L || []).map((x) => `${ic[x.estado] || '•'} #${x.id} ${x.mb}MB → ${x.numero} (${x.estado})`).join('\n') || '(nenhuma)') + `\n\nApp: ${geatorEstado.visto && Date.now() - geatorEstado.visto < 120000 ? '🟢 online' : '🔴 offline'}`);
            continue;
          }
          const mr = bruto.match(/^!\s*repetir\s+#?(\d+)\s*$/i);
          if (proprio && mr) {
            const ok = await rpc('geator_repetir', { p_id: Number(mr[1]) }).catch(() => false);
            acordarFila();
            await env(ok ? `🔁 Entrega #${mr[1]} voltou para a fila.` : `Não encontrei a entrega #${mr[1]} (ou já foi entregue).`);
            continue;
          }
          const mm = bruto.match(/^!\s*(tabela|pagamento|menu|obrigado)\b\s*([\s\S]*)$/i);
          if ((grupo || proprio) && mm) {
            const campo = mm[1].toLowerCase(); const valor = mm[2].trim();
            const alvo = grupo ? jid : 'privado';
            const onde = grupo ? 'neste grupo' : 'no privado deste número';
            if (!valor) { await env(`Para mudar, escreve !${campo} e por baixo o texto novo.\nPara voltar ao original: !${campo} apagar`); continue; }
            S.textos[alvo] = S.textos[alvo] || {};
            if (/^apagar$/i.test(valor)) delete S.textos[alvo][campo]; else S.textos[alvo][campo] = valor;
            await guardaTextos(S).catch((e) => console.error('textos', e.message));
            await env(/^apagar$/i.test(valor) ? `🗑️ ${campo} personalizado apagado ${onde}.` : `✅ Nova ${campo} guardada ${onde}. Já está a funcionar.`);
            continue;
          }
          const mg = bruto.match(/^!\s*gatilho\s+([^\n]+?)\s*(?:\n([\s\S]*))?$/i);
          if ((grupo || proprio) && mg) {
            const alvo = grupo ? jid : 'privado';
            let palavra = mg[1].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[!?.,;:]+$/g, '').trim();
            let resp = (mg[2] || '').trim();
            S.textos[alvo] = S.textos[alvo] || {}; const G = (S.textos[alvo].gatilhos = S.textos[alvo].gatilhos || {});
            if (/ apagar$/.test(palavra) && !resp) { palavra = palavra.replace(/ apagar$/, ''); delete G[palavra]; await guardaTextos(S).catch(() => {}); await env(`🗑️ Gatilho "${palavra}" apagado.`); continue; }
            if (!resp) { await env('Escreve assim:\n!gatilho palavra\nresposta do bot\n\nPara apagar: !gatilho palavra apagar'); continue; }
            G[palavra] = resp; await guardaTextos(S).catch((e) => console.error('textos', e.message));
            await env(`✅ Gatilho criado: quando escreverem "${palavra}", o bot responde.`); continue;
          }
          if ((grupo || proprio) && cmd === 'listar') {
            const T = S.textos[grupo ? jid : 'privado'] || {};
            await env('📋 Personalizado aqui:\n' + (['tabela', 'pagamento', 'menu', 'obrigado'].filter((k) => T[k]).map((k) => '• ' + k).join('\n') || '• (nenhum texto)') + '\n\nGatilhos: ' + (Object.keys(T.gatilhos || {}).join(', ') || '(nenhum)'));
            continue;
          }
          if ((grupo || proprio) && cmd === 'comandos') {
            await env('⚙️ Comandos do dono\n\n!tabela + texto → muda a tabela\n!pagamento + texto → muda o pagamento\n!menu + texto → muda a resposta ao oi/olá\n!obrigado + texto → muda a resposta ao obrigado\n(!tabela apagar, !pagamento apagar… volta ao original)\n\n!gatilho palavra + resposta (linha de baixo) → cria palavra nova\n!gatilho palavra apagar → apaga\n!listar → mostra o que mudaste\n!ativarbot / !desativarbot → liga/desliga o bot no grupo\n\n📲 Entregas automáticas (app GEATOR)\n!pairapp → código para ligar a app\n!enviar 841234567 1GB → manda megas\n!entregas → ver últimas\n!repetir 12 → tenta de novo a #12\n\nNo grupo muda só esse grupo. Na conversa contigo mesmo muda o privado.');
            continue;
          }
        }
        if (type !== 'notify') continue;
        if (grupo && !S.grupos.has(jid) && !GRUPOS_ENV.includes(jid)) continue;
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
        const resposta = await responder(texto, phone, (m.pushName || '').split(' ')[0], { grupo, mencionado, botNumero: S.st.numero, menu: (grupo ? S.textos[jid]?.menu : null) || S.textos.privado?.menu, obrigado: (grupo ? S.textos[jid]?.obrigado : null) || S.textos.privado?.obrigado, gatilhos: grupo ? S.textos[jid]?.gatilhos : S.textos.privado?.gatilhos, tabela: S.textos.privado?.tabela || S.tabela, pagamento: S.textos.privado?.pagamento || S.pagamento, pagamentoGrupo: (grupo && S.textos[jid]?.pagamento) || S.pagamentoGrupo, tabelaGrupo: grupo ? (S.textos[jid]?.tabela || tabelaPorGrupo.get(jid)) : null });
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
const URL_PUBLICA = (process.env.RENDER_EXTERNAL_URL || process.env.URL_PUBLICA || 'https://fast-shop-bot.onrender.com').replace(/\/$/, '');
const semId = (x) => String(x || '').split(':')[0].split('@')[0];
montarGeator(app, {
  avisar: async (r, ok, msg) => {
    const S = SESSOES.find((x) => x.st.estado === 'Conectado' && x.sock);
    if (!S) return;
    const id = () => ({ messageId: 'BOT' + Date.now().toString(16).toUpperCase() });
    if (ok && r.avisar) await S.sock.sendMessage(r.avisar, { text: `✅ Enviámos *${r.mb} MB* para o número *${r.numero}*. Obrigado pela preferência! 🙏` }, id());
    if (!ok) await S.sock.sendMessage(semId(S.sock.user?.id) + '@s.whatsapp.net', { text: `⚠️ Entrega #${r.id} falhou (${r.mb} MB → ${r.numero}).\n${msg || ''}\n\nPara tentar de novo: !repetir ${r.id}` }, id());
  },
});
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
<div style="background:#fff;border-radius:12px;padding:14px;margin:14px 0;box-shadow:0 1px 4px #0002">
<h3 style="margin:0 0 6px">📲 App GEATOR BOT MOBILE</h3>
<p>Estado: <b>${geatorEstado.visto && Date.now() - geatorEstado.visto < 120000 ? '🟢 Ligada' : '🔴 Desligada'}</b> ${geatorEstado.dispositivo ? '· ' + geatorEstado.dispositivo.replace(/[<>&"]/g, '') : ''}</p>
${geatorEstado.ultimo ? `<p>Última entrega pedida: ${geatorEstado.ultimo}</p>` : ''}
${codigoApp && codigoApp.ate > Date.now() ? `<h3>Código: <span style="letter-spacing:2px">${codigoApp.c}</span></h3><p>URL do GEATOR RENT: <b>${URL_PUBLICA}</b></p>` : ''}
<form method="post" action="/geator-codigo${q}">${h}<button style="padding:8px">Gerar código da app</button></form>
</div>
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
let codigoApp = null;
app.post('/geator-codigo', (req, res) => {
  if (!autorizado(req)) return res.sendStatus(401);
  codigoApp = { c: novoCodigo(), ate: Date.now() + 15 * 60_000 };
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
