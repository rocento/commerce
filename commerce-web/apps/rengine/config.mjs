export const storeNames = ['grocery', 'jewelry', 'electronics', 'pharmacy'];
export function configuration(env = process.env) {
  const port = Number(env.PORT ?? 3190);
  const origin = env.RENGINE_ORIGIN ?? `http://127.0.0.1:${port}`;
  const stores = Object.fromEntries(storeNames.map((name, i) => [name, {
    name,
    gateway: env[`RENGINE_${name.toUpperCase()}_GATEWAY`] ?? `http://127.0.0.1:${[8080,58080,59080,60080][i]}`,
    language: env[`RENGINE_${name.toUpperCase()}_LANGUAGE`] ?? `http://127.0.0.1:${[3187,3287,3387,3487][i]}`,
    assistant: env[`RENGINE_${name.toUpperCase()}_ASSISTANT`] ?? `http://127.0.0.1:${8000+i}`,
  }]));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  if (!['http:', 'https:'].includes(new URL(origin).protocol) || new URL(origin).origin !== origin) throw new Error('Invalid RENGINE_ORIGIN');
  for (const store of Object.values(stores)) for (const key of ['gateway', 'language', 'assistant']) {
    const url = new URL(store[key]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid upstream origin');
  }
  if (env.RENGINE_VAULT_FILE && (!env.RENGINE_VAULT_KEY_FILE || !env.RENGINE_OWNER_EMAIL || !storeNames.includes(env.RENGINE_OWNER_STORE ?? 'grocery'))) throw new Error('Saved connections require an encryption key and an operator identity.');
  return { vaultFile:env.RENGINE_VAULT_FILE, vaultKeyFile:env.RENGINE_VAULT_KEY_FILE, ownerEmail:env.RENGINE_OWNER_EMAIL?.toLowerCase(), ownerStore:env.RENGINE_OWNER_STORE ?? 'grocery', port, origin, stores, host: env.HOST ?? '127.0.0.1', secure: origin.startsWith('https://') };
}
