/** Merchant host pairing supports one immutable frontend for all tenants. */
export function storefrontOrigin(configured: string | undefined, location: Pick<Location, 'protocol' | 'hostname'>): string {
  if (configured) return configured;
  if (location.protocol === 'https:' && /^[a-z0-9][a-z0-9-]*-admin\.rocento\.com$/.test(location.hostname)) {
    return `https://${location.hostname.replace(/-admin\.rocento\.com$/, '.rocento.com')}`;
  }
  return `${location.protocol}//${location.hostname}:5173`;
}
