// Estado de autenticação do Baileys guardado no Supabase (tabela wa_auth)
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { rpc } from './db.js';

const enc = (v) => JSON.stringify(v, BufferJSON.replacer);
const dec = (s) => JSON.parse(s, BufferJSON.reviver);

// pre = '' para o número principal (chaves antigas), 's2:' para o 2º número, etc.
export async function useSupabaseAuthState(pre = '') {
  const got = await rpc('bot_auth_get', { p_keys: [pre + 'creds'] });
  const creds = got?.[pre + 'creds'] ? dec(got[pre + 'creds']) : initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const names = ids.map((id) => `${pre}${type}-${id}`);
        const rows = names.length ? await rpc('bot_auth_get', { p_keys: names }) : {};
        const out = {};
        for (const id of ids) {
          const raw = rows?.[`${pre}${type}-${id}`];
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
            batch[`${pre}${type}-${id}`] = v ? enc(v) : null;
          }
        }
        if (Object.keys(batch).length) await rpc('bot_auth_set', { p_data: batch });
      },
    },
  };
  const saveCreds = () => rpc('bot_auth_set', { p_data: { [pre + 'creds']: enc(state.creds) } });
  // Só apaga a sessão DESTE número (não mexe no outro)
  const reset = () => rpc('bot_auth_set', { p_data: { [pre + 'creds']: null } });
  return { state, saveCreds, reset };
}
