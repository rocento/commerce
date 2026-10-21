import {readFileSync, writeFileSync, renameSync} from 'node:fs';
import {createHash, randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';

export const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
export const sessionKey = token => createHash('sha256').update(token).digest('hex');

// Persistent operator sessions share the vault's protected key, but not its file.
// Browser tokens are hashed; credentials and upstream cookies stay encrypted.
export function rememberedSessions(config) {
  if (!config.vaultFile) return null;
  const path = config.vaultFile + '.sessions', key = readFileSync(config.vaultKeyFile);
  let records = {};
  try {
    const bytes = readFileSync(path), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    records = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot open remembered sessions.'); }
  function write(next) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    const data = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
    writeFileSync(path + '.tmp', Buffer.concat([nonce, cipher.getAuthTag(), data]), {mode: 0o600});
    renameSync(path + '.tmp', path); records = next;
  }
  return {
    entries: () => Object.entries(records).filter(([, value]) => value.expires > Date.now() && value.email === config.ownerEmail && value.store === config.ownerStore),
    set: (id, session) => write({...records, [id]: {expires: session.expires, email: config.ownerEmail, store: config.ownerStore, ownerCookie: session.ownerCookie, credentials: session.ownerCredentials}}),
    remove: id => { if (!Object.hasOwn(records, id)) return; const next = {...records}; delete next[id]; write(next); },
    prune: () => {const next = Object.fromEntries(Object.entries(records).filter(([, value]) => value.expires > Date.now() && value.email === config.ownerEmail && value.store === config.ownerStore)); if (Object.keys(next).length !== Object.keys(records).length) write(next);},
  };
}
