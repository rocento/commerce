export interface CatalogFilters { minimum: string; maximum: string; inStock: boolean; sort: 'relevance' | 'price_asc' | 'price_desc' | 'name_asc' | 'name_desc' }
export const emptyFilters: CatalogFilters = { minimum: '', maximum: '', inStock: false, sort: 'relevance' };
export function validFilters(f: CatalogFilters) {
  const min = f.minimum.trim() ? Number(f.minimum) : 0, max = f.maximum.trim() ? Number(f.maximum) : Infinity;
  return Number.isFinite(min) && min >= 0 && max >= min && (!f.maximum.trim() || Number.isFinite(max));
}
export function filterParameters(f: CatalogFilters) {
  if (!validFilters(f)) throw new Error('Invalid price range');
  const p = new URLSearchParams();
  if (f.minimum.trim()) p.set('min_price', f.minimum.trim());
  if (f.maximum.trim()) p.set('max_price', f.maximum.trim());
  if (f.inStock) p.set('in_stock', 'true');
  if (f.sort !== 'relevance') { p.set('sort_by', f.sort.startsWith('price_') ? 'price' : 'name'); p.set('sort_order', f.sort.endsWith('desc') ? 'desc' : 'asc'); }
  return p;
}
