import type { AssistantBlock, Cart } from '@commerce/api-client';
export type CartSnapshot = NonNullable<AssistantBlock['cart']>;
export const cartPageSize = 10;
export function cartPage(cart: CartSnapshot, requested: number) {
  const pages = Math.max(1, Math.ceil(cart.items.length / cartPageSize));
  const page = Math.max(0, Math.min(Math.floor(requested), pages - 1));
  const start = page * cartPageSize;
  return { page, pages, start, items: cart.items.slice(start, start + cartPageSize) };
}
export function completeCartSnapshot(cart: Cart): CartSnapshot {
  return {
    items: cart.items.map(({product_id, name, price, currency, quantity, line_total}) => ({product_id, name, price, currency, quantity, line_total})),
    total_lines: cart.items.length,
    total_quantity: cart.items.reduce((sum, item) => sum + item.quantity, 0),
    subtotal: cart.subtotal, discount_amount: cart.discount_amount,
    currency: cart.currency, fully_reserved: cart.fully_reserved,
  };
}
