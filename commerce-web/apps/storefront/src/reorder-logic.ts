import type { Cart, Location, components } from '@commerce/api-client';
type Address = components['schemas']['FulfillmentLocation'];
/** Compare delivery facts, not labels or IDs, which can survive address edits. */
export function sameReorderAddress(a: Address, b: Address): boolean {
  const fields = ['formatted_address', 'building', 'floor', 'apartment', 'delivery_instructions', 'latitude', 'longitude', 'location_method'] as const;
  return fields.every(key => a[key] === b[key]) && JSON.stringify(a.geography ?? null) === JSON.stringify(b.geography ?? null);
}
export function reorderAddress(original: Address, saved: Location[]): Location | undefined {
  if (original.location_method === 'pickup') return;
  const previous = saved.find(address => sameReorderAddress(original, address));
  const preferred = saved.find(address => address.is_default);
  return previous && (!preferred || sameReorderAddress(original, preferred)) ? previous : undefined;
}
export function reorderCartSignature(cart: Cart): string {
  return JSON.stringify(cart.items.map(item => [item.product_id, item.quantity, item.price]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
}
