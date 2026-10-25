// Respostas automáticas da FAST SHOP 24H
import { rpc } from './db.js';

const SITE = process.env.SITE_URL || 'https://fast-shop-24h.netlify.app';
const mt = (n) => `${Number(n || 0).toLocaleString('pt-PT', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} MT`;
const ESTADO = { pendente: '⏳ Pendente (a aguardar pagamento)', pago: '✅ Pago', enviado: '🚀 Enviado', entregue: '🎉 Entregue', cancelado: '❌ Cancelado' };
const REF_RE = /\bFS24-\d{8}-[A-Z0-9]{4}\b/i;

let infoCache = { t: 0, v: null };
async function info() {
  if (Date.now() - infoCache.t > 5 * 60_000 || !infoCache.v) infoCache = { t: Date.now(), v: await rpc('bot_info') };
  return infoCache.v || {};
}

const MENU = (nome) => `Olá${nome ? ' ' + nome : ''}! 👋 Bem-vindo à *FAST SHOP 24H* ⚡

Responde com o número:
*1* – Ver pacotes e preços
*2* – Como pagar (M-Pesa / e-Mola)
*3* – Estado dos meus pedidos
*4* – Confirmar pagamento
*5* – Falar com o suporte

🛒 Encomendar: ${SITE}`;

const MENU_GRUPO = (num) => `⚡ *FAST SHOP 24H* — escreve uma palavra

*precos* – pacotes e preços
*pagar* – como pagar
*site* – link para encomendar
*horario* – horário de atendimento
*regras* – regras do grupo

🔒 Pedidos, pagamentos e estado só no privado${num ? `: wa.me/${num}` : '.'}
🛒 ${SITE}`;

// Gatilhos editáveis no Supabase (tabela bot_gatilhos), atualizados a cada 1 minuto
let gatCache = { t: 0, v: [] };
async function gatilhos() {
  if (Date.now() - gatCache.t > 60_000) {
    try { gatCache = { t: Date.now(), v: (await rpc('bot_gatilhos_lista')) || [] }; } catch { gatCache.t = Date.now(); }
  }
  return gatCache.v;
}
async function achaGatilho(t, grupo, nome) {
  for (const g of await gatilhos()) {
    if (g.onde === (grupo ? 'privado' : 'grupo')) continue;
    const k = norm(g.gatilho).replace(/^[!/.]/, '');
    const m = t.replace(/^[!/.]/, '');
    if (!k) continue;
    const ok = g.modo === 'contem' ? m.includes(k) : m === k || m.startsWith(k + ' ');
    if (ok) return String(g.resposta).replaceAll('{nome}', nome || '').replaceAll('{site}', SITE);
  }
  return null;
}

// Palavras que abrem o MENU no privado (editável no Render: BOT_MENU_PALAVRAS=oi,ola,menu,...)
// Qualquer outra mensagem que não seja comando fica SEM resposta.
const MENU_PALAVRAS = (process.env.BOT_MENU_PALAVRAS || 'oi,ola')
  .split(',').map((x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()).filter(Boolean);
// Comando só conta se a mensagem for EXATAMENTE a palavra (ignora pontuação no fim)
const igual = (t, lista) => lista.includes(t.replace(/[!?.,;:\s]+$/g, '').trim());

const norm = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export async function responder(texto, phone, nome, op = {}) {
  texto = texto.replace(/@\d+/g, ' ').trim();
  let t = norm(texto);
  const refMatch = texto.toUpperCase().match(REF_RE);

  // Gatilhos criados pelo dono no WhatsApp (!gatilho palavra + resposta)
  const limpa = t.replace(/[!?.,;:\s]+$/g, '').trim();
  if (op.gatilhos && op.gatilhos[limpa]) return String(op.gatilhos[limpa]).replaceAll('{nome}', nome || '');
  if (op.grupo) {
    // No grupo só respondem estas palavras EXATAS (mais os gatilhos do Supabase)
    const g = await achaGatilho(t, true, nome);
    if (g) return g;
    if (refMatch || igual(t, ['paguei', 'ja paguei', 'confirmar', 'estado', 'meus pedidos']))
      return `🔒 ${nome || 'Olá'}, pagamentos e pedidos só no privado, para tua segurança.${op.botNumero ? ` Fala comigo aqui: wa.me/${op.botNumero}` : ''}`;
    if (igual(t, ['tabela', 'posso ter megas', 'ainda ha promocao'])) return op.tabelaGrupo || responder('1', phone, nome, { tabela: op.tabela });
    if (igual(t, ['pagamento'])) return op.pagamentoGrupo || responder('2', phone, nome, { pagamento: op.pagamento });
    if (igual(t, ['obrigado', 'obrigada'])) return op.obrigado || responder('obrigado', phone, nome);
    return null; // no grupo, fica calado no resto
  }

  // "FS24-20261023-AB12 8ABC12XYZ" -> confirmar pagamento
  if (refMatch) {
    const ref = refMatch[0];
    const resto = texto.toUpperCase().replace(ref, ' ').replace(/[^A-Z0-9.]/g, ' ').trim().split(/\s+/).filter((w) => w.length >= 6);
    const txid = resto.sort((a, b) => b.length - a.length)[0];
    if (!txid) return `Recebi o pedido *${ref}*. Agora envia o ID da transação do SMS de pagamento, assim:\n*${ref} ID-DA-TRANSAÇÃO*`;
    const r = await rpc('bot_submit_reference', { p_phone: phone, p_order_ref: ref, p_txid: txid });
    if (!r?.ok) {
      if (r?.erro === 'pedido_nao_encontrado') return `Não encontrei o pedido *${ref}* associado a este número. Confirma a referência ou fala com o suporte (*5*).`;
      if (r?.erro === 'id_curto') return 'Esse ID da transação parece curto demais. Copia o ID completo do SMS do M-Pesa/e-Mola.';
      return 'Não consegui registar o pagamento agora. Tenta de novo daqui a pouco ou fala com o suporte (*5*).';
    }
    if (r.estado === 'confirmado') return `✅ Pagamento do pedido *${r.reference}* confirmado! Vamos processar já.`;
    if (r.estado === 'pendente') return `📝 Registei o ID *${txid}* no pedido *${r.reference}* (${mt(r.total)}).\nAssim que o SMS do pagamento chegar, confirmo automaticamente e aviso aqui.`;
    return `O pagamento do pedido *${r.reference}* já está: *${r.estado}*.`;
  }

  const gat = await achaGatilho(t, false, nome);
  if (gat) return gat;
  t = t.replace(/^[!/.]/, '');

  if (igual(t, ['1', 'tabela', 'posso ter megas', 'ainda ha promocao'])) {
    if (op.tabela) return op.tabela; // número com tabela própria
    const cat = await rpc('bot_catalog');
    if (!cat?.length) return `De momento não há produtos disponíveis. Vê o site: ${SITE}`;
    const porCat = new Map();
    for (const p of cat) {
      const c = p.cat || 'Outros';
      if (!porCat.has(c)) porCat.set(c, []);
      porCat.get(c).push(`• ${p.name} — *${mt(p.price)}*`);
    }
    let out = '📦 *Pacotes e preços*\n';
    for (const [c, l] of porCat) out += `\n*${c}*\n${l.slice(0, 15).join('\n')}${l.length > 15 ? `\n…e mais ${l.length - 15}` : ''}\n`;
    return (out + `\n🛒 Encomenda aqui: ${SITE}`).slice(0, 3800);
  }

  if (igual(t, ['2', 'pagamento'])) {
    if (op.pagamento) return op.pagamento; // número com pagamento próprio
    const i = await info();
    return `💳 *Como pagar*\n\n${i.mpesa || 'M-Pesa: ver no site.'}\n\n${i.emola || ''}\n\nDepois de pagar, envia aqui a referência do pedido e o ID da transação:\n*FS24-XXXXXXXX-XXXX ID-DA-TRANSAÇÃO*`.trim();
  }

  if (igual(t, ['3'])) {
    const ords = await rpc('bot_my_orders', { p_phone: phone });
    if (!ords?.length) return `Não encontrei pedidos com este número. Se usaste outro número no site, envia a referência do pedido (FS24-…).\n🛒 ${SITE}`;
    return '🧾 *Os teus últimos pedidos*\n\n' + ords.map((o) => `*${o.reference}* — ${mt(o.total)}\n${ESTADO[o.status] || o.status}`).join('\n\n');
  }

  if (igual(t, ['4'])) {
    return 'Envia numa só mensagem a referência do pedido e o ID da transação do SMS, assim:\n*FS24-20261023-AB12 8ABC12XYZ*\n\nEu confirmo automaticamente quando o pagamento entrar. ⚡';
  }

  if (igual(t, ['5'])) {
    const i = await info();
    const tel = i.support_whatsapp || i.support_phone || '848033355';
    return `👤 O suporte vai responder-te aqui em breve.\nHorário: todos os dias 08:30/09:00–22:30.\nContacto: ${tel}`;
  }

  if (igual(t, MENU_PALAVRAS)) return op.menu ? op.menu.replaceAll('{nome}', nome || '') : MENU(nome);
  if (igual(t, ['obrigado', 'obrigada', 'obrigado/a'])) return op.obrigado ||  `❤️ Gostaste do nosso serviço?

Ficamos muito felizes quando alguém nos recomenda. 🙏

Se conheceres alguém que precisa de megas, podes indicar o NET Fast. 📶

Obrigado por fazeres parte da nossa comunidade! 🤝`;
  return null; // qualquer outra palavra: o bot fica calado
}

export const ehHumanoPedido = (texto) => /^5[!?.\s]*$/i.test(norm(texto));
