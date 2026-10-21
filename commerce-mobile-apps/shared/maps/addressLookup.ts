/** Address suggestions are approximate; the selected pin remains authoritative. */
export function formatPinAddress(data: unknown): string {
  const p = (data as { features?: { properties?: Record<string, unknown> }[] })?.features?.[0]?.properties;
  if (!p) throw new Error('Address unavailable');
  const value = (key: string) => typeof p[key] === 'string' ? (p[key] as string).trim() : '';
  const street = value('street') || value('name');
  const parts = [street, value('district'), value('city'), value('state'), value('country')];
  const address = [...new Set(parts.filter(Boolean))].join(', ').slice(0, 200);
  if (!street || !address) throw new Error('Address unavailable');
  return address;
}
export async function lookupPinAddress(base: string, latitude: string, longitude: string, locale: string, signal: AbortSignal): Promise<string> {
  const lat = Number(latitude), lon = Number(longitude);
  if (!latitude.trim() || !longitude.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>85 || Math.abs(lon)>180) throw new Error('Invalid pin');
  const response = await fetch(`${base}/v1/location-address?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&lang=${locale === 'ar' ? 'ar' : 'en'}`, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error('Address unavailable');
  return formatPinAddress(await response.json());
}
