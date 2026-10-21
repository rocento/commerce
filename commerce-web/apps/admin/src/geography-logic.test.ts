import { describe, expect, it } from 'vitest';
import type { OrderDetail } from '@commerce/api-client';
import { catalogSales, groupLocations, loadGeoDetails, salesTotals } from './geography-logic';

const filters = { search: '', product: '', from: '', to: '' };
function detail(id: string, status = 'delivered', currency = 'EGP'): OrderDetail {
  return {
    order: { id, status, currency, created_at: '2026-10-01T12:00:00Z', location: { latitude: 30, longitude: 31, formatted_address: 'Cairo' } },
    items: [{ product_id: 'apple', name: 'Apple', sku: 'AP-1', quantity: 2, line_total: '40.50', discount_amount: '0.50' }, { product_id: 'pear', name: 'Pear', sku: 'PE-1', quantity: 1, line_total: '15.00', discount_amount: '0' }],
  } as OrderDetail;
}

describe('catalog and customer geography', () => {
  it('groups shared addresses, retains all entries and rejects invalid coordinates', () => {
    const points = groupLocations([{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }, { latitude: NaN, longitude: 31 }, { latitude: null, longitude: 31 }, { latitude: 91, longitude: 31 }, { latitude: 30, longitude: Infinity }], entry => entry);
    expect(points).toHaveLength(1);
    expect(points[0].entries).toHaveLength(2);
  });
  it('excludes cancelled and failed sales while filtering products, SKU, address and dates', () => {
    const details = [detail('a'), detail('b', 'cancelled'), detail('c', 'delivery_failed')];
    expect(catalogSales(details, filters)).toHaveLength(2);
    expect(catalogSales(details, { ...filters, product: 'apple', search: ' ap-1 ', from: '2026-10-01', to: '2026-10-01' }).map(sale => sale.order.id)).toEqual(['a']);
    expect(catalogSales(details, { ...filters, search: 'cairo' })).toHaveLength(2);
    expect(catalogSales(details, { ...filters, from: '2026-10-02' })).toHaveLength(0);
    expect(catalogSales(details, { ...filters, to: '2026-09-30' })).toHaveLength(0);
  });
  it('keeps currencies separate and subtracts line discounts without multiplying line totals again', () => {
    const sales = catalogSales([detail('a'), detail('b', 'delivered', 'USD')], { ...filters, product: 'apple' });
    expect(salesTotals(sales)).toBe('40.00 EGP · 40.00 USD');
  });
  it('bounds detail concurrency and preserves result order', async () => {
    let active = 0, peak = 0;
    const result = await loadGeoDetails(Array.from({ length: 12 }, (_, i) => i), async item => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--; return item;
    }, new AbortController().signal);
    expect(peak).toBe(5);
    expect(result).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });
  it('fails incomplete pages and stops loading after cancellation', async () => {
    await expect(loadGeoDetails([1], async () => { throw new Error('Profile unavailable'); }, new AbortController().signal)).rejects.toThrow('Profile unavailable');
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(loadGeoDetails([1], async item => { calls++; return item; }, controller.signal)).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
