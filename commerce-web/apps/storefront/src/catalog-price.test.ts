import { expect, it } from 'vitest';
import { catalogPrice } from './catalog-price';
import type { Product } from '@commerce/api-client';
const product = {id:'p1',price:'100.00',currency:'USD',catalog_offer:{product_id:'p1',original_price:'100',discounted_price:'90.00',currency:'USD'}} as Product;
it('accepts equivalent decimal base prices', () => {
  expect(catalogPrice(product)).toEqual({price:'90.00',originalPrice:'100.00'});
});
it.each([
 {product_id:'p2'}, {currency:'EGP'}, {original_price:'101'},
 {discounted_price:'-1'}, {discounted_price:'NaN'}, {discounted_price:'101'},
 {discounted_price:'100'}, {original_price:'1e2'},
])('rejects an invalid offer %j', change => {
 expect(catalogPrice({...product,catalog_offer:{...product.catalog_offer!,...change}}).price).toBe('100.00');
});
it('does not collapse distinct large decimal prices', () => {
 expect(catalogPrice({...product,price:'9007199254740992',catalog_offer:{...product.catalog_offer!,original_price:'9007199254740993'}}).price).toBe('9007199254740992');
});
it('allows a verified zero-price offer', () => {
 expect(catalogPrice({...product,catalog_offer:{...product.catalog_offer!,discounted_price:'0'}}).price).toBe('0');
});
