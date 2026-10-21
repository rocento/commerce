import { describe, it, expect } from 'vitest';
import { ApiError, type CheckoutQuote, type Cart } from '@commerce/api-client';
import { cartFingerprint, checkoutMoney, definitiveCheckoutRejection, quoteExpired, readCheckoutAttempt } from './checkout-logic';
const quote = { id: '11111111-1111-4111-8111-111111111111', expires_at: '2026-09-17T12:00:00Z', snapshot: { items: [], location: {}, contact: {}, currency: 'USD', total: '42.00' } } as unknown as CheckoutQuote;
describe('checkout submission safeguards', () => {
  it('keeps the same submission even after quote expiry so a committed order can be recovered', () => {
    const saved = { key: '22222222-2222-4222-8222-222222222222', quote };
    const attempt = readCheckoutAttempt({ getItem: () => JSON.stringify(saved) }, 'key');
    expect(attempt).toEqual(saved);
    expect(quoteExpired(quote, Date.parse('2026-09-17T12:00:01Z'))).toBe(true);
    expect(quoteExpired(quote, Date.parse('2026-09-17T11:59:59Z'))).toBe(false);
    expect(quoteExpired({ ...quote, expires_at: 'invalid' })).toBe(true);
  });
  it('never silently discards corrupted or inaccessible checkout state', () => {
    expect(readCheckoutAttempt({ getItem: () => null }, 'key')).toBeNull();
    expect(() => readCheckoutAttempt({ getItem: () => '{' }, 'key')).toThrow();
    expect(() => readCheckoutAttempt({ getItem: () => JSON.stringify({ key: 'bad', quote }) }, 'key')).toThrow();
    expect(() => readCheckoutAttempt({ getItem: () => { throw new Error('Blocked'); } }, 'key')).toThrow();
  });
  it('retains uncertain attempts for transport failures, rate limits, auth failures and server errors', () => {
    for (const status of [401, 403, 408, 429, 500, 502, 503]) expect(definitiveCheckoutRejection(new ApiError('Retry', status))).toBe(false);
    expect(definitiveCheckoutRejection(new TypeError('Network unavailable'))).toBe(false);
    for (const status of [400, 404, 409, 422]) expect(definitiveCheckoutRejection(new ApiError('Rejected', status))).toBe(true);
  });
  it('invalidates reviewed totals when quantities, prices, coupons or reservations change', () => {
    const cart = { id: 'cart', currency: 'USD', coupon_code: null, discount_amount: '0', fully_reserved: true, items: [{ product_id: 'product', quantity: 1, price: '20', line_total: '20', expires_at: 'before' }] } as unknown as Cart;
    const original = cartFingerprint(cart);
    expect(cartFingerprint({ ...cart, items: [{ ...cart.items[0], expires_at: 'after' }] })).toBe(original);
    expect(cartFingerprint({ ...cart, items: [{ ...cart.items[0], quantity: 2 }] })).not.toBe(original);
    expect(cartFingerprint({ ...cart, coupon_code: 'SAVE' })).not.toBe(original);
    expect(cartFingerprint({ ...cart, fully_reserved: false })).not.toBe(original);
    expect(checkoutMoney('1234.5', 'USD')).toBe('$1,234.50');
    expect(checkoutMoney('invalid', 'USD')).toBe('—');
  });
});
