import { ApiError, type Cart, type CheckoutQuote } from '@commerce/api-client';
export type CheckoutAttempt = { quote: CheckoutQuote; key: string };
export { displayMoney as checkoutMoney } from './market-money';
export function cartFingerprint(cart?: Cart) {
  return cart ? JSON.stringify([cart.id, cart.currency, cart.coupon_code, cart.discount_amount, cart.fully_reserved,
    cart.items.map(item => [item.product_id, item.quantity, item.price, item.line_total])]) : '';
}
export function quoteExpired(quote: CheckoutQuote | null | undefined, now = Date.now()) {
  return !quote || !Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= now;
}
export function readCheckoutAttempt(storage: Pick<Storage, 'getItem'>, key: string): CheckoutAttempt | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('Your saved checkout could not be read. Check your orders or contact support before trying again.'); }
  const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  if (!value || !uuid.test(value.key) || !uuid.test(value.quote?.id) || !Number.isFinite(Date.parse(value.quote?.expires_at)) ||
      !Array.isArray(value.quote?.snapshot?.items) || !value.quote.snapshot.location || !value.quote.snapshot.contact ||
      typeof value.quote.snapshot.currency !== 'string' || !Number.isFinite(Number(value.quote.snapshot.total))) {
    throw new Error('Your saved checkout could not be read. Check your orders or contact support before trying again.');
  }
  return value;
}
// These responses reject the transaction. Timeouts, auth/rate limits and server
// errors retain the same key because an interrupted request may have committed.
export function definitiveCheckoutRejection(error: unknown) {
  return error instanceof ApiError && [400, 404, 409, 422].includes(error.status);
}
