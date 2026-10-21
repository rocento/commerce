import type { Product } from '@commerce/api-client';

// Compare decimal strings exactly, without rounding large values through Number.
function decimal(value: string): [bigint, number] | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return [BigInt(match[1] + fraction), fraction.length];
}
function compare(a: [bigint, number], b: [bigint, number]): bigint {
  const scale = Math.max(a[1], b[1]);
  return a[0] * 10n ** BigInt(scale - a[1]) - b[0] * 10n ** BigInt(scale - b[1]);
}
export function catalogPrice(product: Pick<Product, 'id' | 'price' | 'currency' | 'catalog_offer'>) {
  const offer = product.catalog_offer;
  const base = decimal(product.price);
  const original = offer && decimal(offer.original_price);
  const discounted = offer && decimal(offer.discounted_price);
  const valid = offer && offer.product_id === product.id && offer.currency === product.currency
    && base && original && discounted && compare(base, original) === 0n && compare(discounted, base) < 0n;
  return { price: valid ? offer.discounted_price : product.price, originalPrice: valid ? product.price : undefined };
}
