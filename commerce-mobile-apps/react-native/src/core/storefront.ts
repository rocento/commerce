import market from './data/catalog-1.json';
import boutique from './data/catalog-2.json';

export type Locale = 'en' | 'ar';
export type StoreId = 'market' | 'boutique';
export interface Localized { name: string; nameAr: string }
export interface Product extends Localized {
  id: string;
  description: string;
  descriptionAr: string;
  price: string;
  currency: string;
  in_stock: boolean;
  category_id: string;
  symbol: string;
}
export interface Catalog {
  merchantId: string;
  categories: (Localized & { id: string; slug: string })[];
  products: Product[];
}
export interface StorefrontSnapshot {
  id: StoreId;
  name: Localized;
  catalog: Catalog;
}
// Screens depend only on this core-owned provider, independent of Studio.
export interface StorefrontConfiguration {
  getSnapshot(store: StoreId): StorefrontSnapshot;
}
export const bundledConfiguration: StorefrontConfiguration = {
  getSnapshot: (store) => store === 'market'
    ? { id: store, name: { name: 'Demo Market', nameAr: 'السوق التجريبي' }, catalog: market }
    : { id: store, name: { name: 'Demo Boutique', nameAr: 'البوتيك التجريبي' }, catalog: boutique },
};
export const localized = (value: Localized, locale: Locale) => locale === 'ar' ? value.nameAr : value.name;

export function filterProducts(catalog: Catalog, query: string, category: string | null): Product[] {
  const search = query.trim().toLocaleLowerCase();
  return catalog.products.filter(product => (!category || product.category_id === category)
    && `${product.name} ${product.nameAr}`.toLocaleLowerCase().includes(search));
}

// The shared demo fixtures use two-decimal USD prices. Reject invalid amounts.
export function priceInCents(price: string): number {
  if (!/^\d+\.\d{2}$/.test(price)) throw new Error('Invalid catalog price');
  const [whole, fraction] = price.split('.');
  const cents = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(cents)) throw new Error('Catalog price exceeds supported range');
  return cents;
}
export function money(cents: number, currency: string, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {
    style: 'currency', currency,
  }).format(cents / 100);
}

export interface Bag { merchantId: string; quantities: Record<string, number> }
export const emptyBag = (catalog: Catalog): Bag => ({ merchantId: catalog.merchantId, quantities: {} });
export function changeQuantity(bag: Bag, catalog: Catalog, productId: string, delta: number): Bag {
  const current = bag.merchantId === catalog.merchantId ? bag : emptyBag(catalog);
  const product = catalog.products.find(item => item.id === productId);
  if (!product || !Number.isInteger(delta) || (delta > 0 && !product.in_stock)) return current;
  const quantity = Math.max(0, Math.min(99, (current.quantities[productId] ?? 0) + delta));
  const quantities = { ...current.quantities };
  if (quantity === 0) delete quantities[productId];
  else quantities[productId] = quantity;
  return { ...current, quantities };
}
export function bagLines(bag: Bag, catalog: Catalog) {
  if (bag.merchantId !== catalog.merchantId) return [];
  return catalog.products.flatMap(product => {
    const quantity = bag.quantities[product.id] ?? 0;
    return quantity > 0 ? [{ product, quantity, subtotal: priceInCents(product.price) * quantity }] : [];
  });
}
