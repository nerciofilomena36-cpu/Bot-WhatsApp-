// Estado de autenticação do Baileys guardado no Supabase (tabela wa_auth)
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { rpc } from './db.js';

const enc = (v) => JSON.stringify(v, BufferJSON.replacer);
const dec = (s) => JSON.parse(s, BufferJSON.reviver);

export async function useSupabaseAuthState() {
  const got = await rpc('bot_auth_get', { p_keys: ['creds'] });
  const creds = got?.creds ? dec(got.creds) : initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const names = ids.map((id) => `${type}-${id}`);
        const rows = names.length ? await rpc('bot_auth_get', { p_keys: names }) : {};
        const out = {};
        for (const id of ids) {
          const raw = rows?.[`${type}-${id}`];
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
            batch[`${type}-${id}`] = v ? enc(v) : null;
          }
        }
        if (Object.keys(batch).length) await rpc('bot_auth_set', { p_data: batch });
      },
    },
  };
  const saveCreds = () => rpc('bot_auth_set', { p_data: { creds: enc(state.creds) } });
  const reset = () => rpc('bot_auth_reset');
  return { state, saveCreds, reset };
}
