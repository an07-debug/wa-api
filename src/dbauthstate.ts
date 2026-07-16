import { Collection } from 'mongodb';
import {
  AuthenticationCreds,
  AuthenticationState,
  initAuthCreds,
  proto,
  SignalDataTypeMap,
  BufferJSON
} from 'baileys';

/**
 * Persists Baileys auth (creds + signal keys) to MongoDB instead of disk.
 * Necessary on Render's free tier because the local filesystem is wiped
 * every time the service spins down or redeploys - re-scanning the QR
 * every time would be both annoying and a ban-risk pattern.
 *
 * Data is stored as a single document per session so a get/save round
 * trip is cheap. Fine for personal single-number use; shard by _id if
 * you ever run multiple sessions.
 */
export async function useDbAuthState(sessionsCollection: Collection, sessionId = 'default') {
  const filter = { _id: sessionId as any };

  const stored = await sessionsCollection.findOne(filter);

  const creds: AuthenticationCreds = stored?.creds
    ? JSON.parse(JSON.stringify(stored.creds), BufferJSON.reviver)
    : initAuthCreds();

  const keys: Record<string, Record<string, any>> = stored?.keys
    ? JSON.parse(JSON.stringify(stored.keys), BufferJSON.reviver)
    : {};

  const writeToDb = async () => {
    await sessionsCollection.updateOne(
      filter,
      {
        $set: {
          creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
          keys: JSON.parse(JSON.stringify(keys, BufferJSON.replacer)),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const bucket = keys[type] || {};
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = bucket[id];
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          if (value !== undefined) result[id] = value;
        }
        return result;
      },
      set: async (data) => {
        for (const category in data) {
          keys[category] = keys[category] || {};
          Object.assign(keys[category], (data as any)[category]);
        }
        await writeToDb();
      }
    }
  };

  return {
    state,
    saveCreds: writeToDb
  };
}
