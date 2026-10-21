import { displayPrice, type LiveProduct, type Locale } from './commerce';
import { isID } from './assistant';
import { FeatureState } from './featureState';

export function comparisonValue(value: unknown, locale: Locale) {
  if (typeof value === 'boolean') return locale === 'ar' ? value ? 'نعم' : 'لا' : value ? 'Yes' : 'No';
  return typeof value === 'string' && value.trim() || typeof value === 'number' && Number.isFinite(value) ? String(value) : locale === 'ar' ? 'غير متوفر' : 'Not provided';
}
export function comparisonRows(products: LiveProduct[], locale: Locale) {
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  return [
    { label: t('Price', 'السعر'), values: products.map(p => (p.product_type ?? 'simple') === 'simple' ? `${displayPrice(p)} ${p.currency}` : t('Choose options for pricing', 'اختر الخيارات لمعرفة السعر')) },
    { label: t('Selling unit', 'وحدة البيع'), values: products.map(p => comparisonValue(p.unit, locale)) },
    { label: t('Availability', 'التوفر'), values: products.map(p => (p.product_type ?? 'simple') !== 'simple' ? t('Choose options to check availability', 'اختر الخيارات للتحقق من التوفر') : p.in_stock ? t('In stock', 'متوفر') : t('Out of stock', 'غير متوفر')) },
    { label: t('Description', 'الوصف'), values: products.map(p => comparisonValue(p.description, locale)) },
    ...[...new Set(products.flatMap(p => Object.keys(p.attributes ?? {})))].sort().map(key => ({ label: key.replace(/[_-]/g, ' '), values: products.map(p => comparisonValue(p.attributes?.[key], locale)) })),
  ];
}
export class ComparisonStore extends FeatureState<{ ids: string[]; products: LiveProduct[]; failed: string[]; busy: boolean }> {
  constructor() { super({ ids: [], products: [], failed: [], busy: false }); }
  reset() { this.generation++; this.publish({ ids: [], products: [], failed: [], busy: false }); }
  toggle(id: string) {
    if (!isID(id)) return;
    id = id.toLowerCase(); const ids = this.state.ids.includes(id) ? this.state.ids.filter(v => v !== id) : this.state.ids.length < 5 ? [...this.state.ids, id] : this.state.ids;
    this.generation++; this.publish({ ids, products: [], failed: [], busy: false });
  }
  get prompt() { return this.state.ids.length >= 2 ? `Compare these products: ${this.state.ids.map(id => `/products/${id}`).join(' ')}` : ''; }
  async load(fetch: (id: string) => Promise<LiveProduct>) {
    const revision = ++this.generation, ids = [...this.state.ids];
    this.publish({ ...this.state, products: [], failed: [], busy: true });
    const products: LiveProduct[] = [], failed: string[] = [];
    for (const id of ids) { try { const p = await fetch(id); if (p.id !== id || p.active === false) throw new Error('Unavailable'); products.push(p); } catch { failed.push(id); } if (revision !== this.generation) return; }
    this.publish({ ids, products, failed, busy: false });
  }
}
