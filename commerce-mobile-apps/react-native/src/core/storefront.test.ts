import { describe, expect, it } from 'vitest';
import { bagLines, bundledConfiguration, changeQuantity, emptyBag, filterProducts, localized, priceInCents } from './storefront';

const market = bundledConfiguration.getSnapshot('market').catalog;
const boutique = bundledConfiguration.getSnapshot('boutique').catalog;
const apple = market.products[0]!;
describe('standalone catalog and bag', () => {
  it('searches both languages and respects category selection', () => {
    expect(filterProducts(market, ' APPLES ', null).map(p => p.id)).toEqual([apple.id]);
    expect(filterProducts(market, 'تفاح', market.categories[0]!.id)).toEqual([apple]);
    expect(filterProducts(market, 'apple', 'unknown')).toEqual([]);
    expect(localized(apple, 'ar')).toBe('تفاح طازج');
  });
  it('adds, adjusts and removes items using exact minor-unit totals', () => {
    let bag = changeQuantity(emptyBag(market), market, apple.id, 3);
    expect(bagLines(bag, market)[0]?.subtotal).toBe(1050);
    bag = changeQuantity(bag, market, apple.id, -1);
    expect(bagLines(bag, market)[0]?.subtotal).toBe(700);
    bag = changeQuantity(bag, market, apple.id, -2);
    expect(bagLines(bag, market)).toEqual([]);
    expect(bag.quantities).toEqual({});
  });
  it('cannot expose or carry a different merchant bag into a store', () => {
    const bag = changeQuantity(emptyBag(market), market, apple.id, 2);
    expect(bagLines(bag, boutique)).toEqual([]);
    const next = changeQuantity(bag, boutique, boutique.products[0]!.id, 1);
    expect(next.merchantId).toBe(boutique.merchantId);
    expect(next.quantities[apple.id]).toBeUndefined();
    expect(bagLines(next, boutique)).toHaveLength(1);
  });
  it('rejects unavailable and unknown products and fractional quantities', () => {
    const unavailable = { ...market, products: [{ ...apple, in_stock: false }] };
    const bag = emptyBag(market);
    expect(changeQuantity(bag, unavailable, apple.id, 1)).toEqual(bag);
    expect(changeQuantity(bag, market, 'unknown', 1)).toEqual(bag);
    expect(changeQuantity(bag, market, apple.id, 0.5)).toEqual(bag);
    const full = changeQuantity(bag, market, apple.id, 200);
    expect(full.quantities[apple.id]).toBe(99);
    expect(changeQuantity(full, unavailable, apple.id, -99).quantities).toEqual({});
  });
  it('rejects malformed prices instead of displaying an inaccurate total', () => {
    expect(priceInCents('4.20')).toBe(420);
    for (const invalid of ['-1.00', 'NaN', '3.005', '1e2', '', '900719925474099100.00']) {
      expect(() => priceInCents(invalid)).toThrow();
    }
  });
});
