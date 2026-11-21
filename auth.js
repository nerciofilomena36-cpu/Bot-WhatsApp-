// Estado de autenticação do Baileys guardado no Supabase (tabela wa_auth)
// Escritas em FILA (uma de cada vez, por ordem) e com repetição até gravar:
// evita que uma chave antiga sobreponha uma nova (causa de "No session" / "Over 2000 messages").
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { rpc } from './db.js';

const enc = (v) => JSON.stringify(v, BufferJSON.replacer);
const dec = (s) => JSON.parse(s, BufferJSON.reviver);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const FILAS = new Set();
// Grava tudo o que estiver pendente (usado antes de desligar o servidor)
export async function gravarTudo() { await Promise.all([...FILAS].map((f) => f.flush())); }

function novaFila(pre) {
  let pend = {}; let corre = null;
  const f = {
    add(batch) { Object.assign(pend, batch); return f.flush(); },
    flush() {
      if (!corre) corre = (async () => {
        while (Object.keys(pend).length) {
          const lote = pend; pend = {};
          for (let t = 0; ; t++) {
            try { await rpc('bot_auth_set', { p_data: lote }); break; } catch (e) {
              console.error('auth gravar', pre || 'principal', 'tentativa', t + 1, e.message);
              await espera(Math.min(30000, 1000 * 2 ** t));
              pend = { ...lote, ...pend }; // mantém o mais recente
              Object.assign(lote, pend); pend = {};
            }
          }
        }
      })().finally(() => { corre = null; });
      return corre;
    },
  };
  FILAS.add(f);
  return f;
}

// Estado em memória por número: ao religar (queda de rede) usa o mesmo, sem reler chaves velhas
const CACHE = new Map();

// pre = '' para o número principal (chaves antigas), 's2:' para o 2º número, etc.
export async function useSupabaseAuthState(pre = '', { fresco = false } = {}) {
  if (!fresco && CACHE.has(pre)) { const c = CACHE.get(pre); await c.fila.flush(); return c.api; }
  const fila = CACHE.get(pre)?.fila || novaFila(pre);
  await fila.flush();
  const got = await rpc('bot_auth_get', { p_keys: [pre + 'creds', pre + 'gen'] });
  const creds = got?.[pre + 'creds'] ? dec(got[pre + 'creds']) : initAuthCreds();
  // "gen" separa as chaves de cada ligação: ao religar o número começa com chaves limpas
  const kp = pre + (got?.[pre + 'gen'] || '');
  const mem = new Map(); // chaves já lidas/gravadas neste processo

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const out = {}; const falta = [];
        for (const id of ids) { const k = `${kp}${type}-${id}`; if (mem.has(k)) { if (mem.get(k)) out[id] = mem.get(k); } else falta.push(id); }
        const names = falta.map((id) => `${kp}${type}-${id}`);
        const rows = names.length ? await rpc('bot_auth_get', { p_keys: names }) : {};
        for (const id of falta) {
          const raw = rows?.[`${kp}${type}-${id}`];
          if (!raw) continue;
          let v = dec(raw);
          if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
          out[id] = v;
        }
        return out;
      },
      set: async (data) => {
        const batch = {};
        for (const type in data) {
          for (const id in data[type]) {
            const v = data[type][id];
            const k = `${kp}${type}-${id}`;
            mem.set(k, v || null);
            batch[k] = v ? enc(v) : null;
          }
        }
        if (Object.keys(batch).length) await fila.add(batch);
      },
    },
  };
  const saveCreds = () => fila.add({ [pre + 'creds']: enc(state.creds) });
  // Só apaga a sessão DESTE número (não mexe no outro); a próxima ligação começa do zero
  const reset = async () => { CACHE.delete(pre); await fila.add({ [pre + 'creds']: null, [pre + 'gen']: 'g' + Date.now().toString(36) + ':' }); };
  const api = { state, saveCreds, reset };
  CACHE.set(pre, { fila, api });
  return api;
}
