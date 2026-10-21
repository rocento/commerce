import { locationAddress, type adminCustomerApi, type OrderDetail } from '@commerce/api-client';

export type CustomerGeoProfile = Awaited<ReturnType<typeof adminCustomerApi.profile>>;
export type CustomerGeoEntry = { customer: CustomerGeoProfile; location: CustomerGeoProfile['locations'][number] };
export type CatalogSale = { order: OrderDetail['order']; item: OrderDetail['items'][number] };
export type GeoPoint<T> = { key: string; latitude: number; longitude: number; entries: T[] };

export function groupLocations<T>(entries: T[], location: (entry: T) => { latitude?: number | null; longitude?: number | null }): GeoPoint<T>[] {
  const points = new Map<string, GeoPoint<T>>();
  for (const entry of entries) {
    const { latitude, longitude } = location(entry);
    if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    const key = `${latitude},${longitude}`;
    const point = points.get(key) ?? { key, latitude, longitude, entries: [] };
    point.entries.push(entry);
    points.set(key, point);
  }
  return [...points.values()];
}

export function catalogSales(details: Pick<OrderDetail, 'order' | 'items'>[], filters: { product: string; search: string; from: string; to: string }): CatalogSale[] {
  return details.flatMap(({ order, items }) => {
    const day = order.created_at.slice(0, 10);
    if (['cancelled', 'delivery_failed'].includes(order.status) || (filters.from && day < filters.from) || (filters.to && day > filters.to)) return [];
    return items.filter(item => (!filters.product || item.product_id === filters.product) && `${item.name} ${item.sku} ${locationAddress(order.location)}`.toLowerCase().includes(filters.search.trim().toLowerCase())).map(item => ({ order, item }));
  });
}

export function salesTotals(sales: CatalogSale[]) {
  const amounts = new Map<string, number>();
  for (const { order, item } of sales) amounts.set(order.currency, (amounts.get(order.currency) ?? 0) + Number(item.line_total) - Number(item.discount_amount));
  return [...amounts].map(([currency, amount]) => `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 3 })} ${currency}`).join(' · ') || '—';
}

export function customerGeoName(customer: CustomerGeoProfile) {
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.account.email || customer.account.mobile_number || 'Unnamed customer';
}

// Bound detail requests so loading another page does not flood the API.
export async function loadGeoDetails<T, R>(items: T[], load: (item: T) => Promise<R>, signal: AbortSignal): Promise<R[]> {
  const result: R[] = [];
  for (let index = 0; index < items.length; index += 5) {
    signal.throwIfAborted();
    result.push(...await Promise.all(items.slice(index, index + 5).map(load)));
  }
  signal.throwIfAborted();
  return result;
}
