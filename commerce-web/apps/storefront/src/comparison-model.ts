export const comparisonLimit = 5;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function comparisonIds(value: string | null): string[] {
  if (!value) return [];
  const ids = value.split(',');
  if (ids.length > comparisonLimit || ids.some(id => !uuid.test(id))) return [];
  return [...new Set(ids.map(id => id.toLowerCase()))];
}
export function comparisonPrompt(ids: string[]): string {
  const checked = comparisonIds(ids.join(','));
  return checked.length >= 2 ? `Compare these products: ${checked.map(id => `/products/${id}`).join(' ')}` : '';
}
export function comparisonValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return typeof value === 'string' && value.trim() || typeof value === 'number' && Number.isFinite(value) ? String(value) : 'Not provided';
}

export function mergeComparison(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming].flatMap(id => comparisonIds(id)))].slice(0, comparisonLimit);
}
export function toggleComparison(current: string[], id: string): string[] {
  return current.includes(id) ? current.filter(value => value !== id) : mergeComparison(current, [id]);
}
