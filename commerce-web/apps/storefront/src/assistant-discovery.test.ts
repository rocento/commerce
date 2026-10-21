import { expect, it, vi } from 'vitest';
import { catalogApi } from '@commerce/api-client';
import { assistantProductBlock, discoverAssistantProducts } from './assistant-discovery';
import type { Product } from '@commerce/api-client';
it('uses the verified offer price for the shared recommendation card', () => {
  const product = {id:'p',name:'Milk',price:'5',currency:'USD',in_stock:true,media_ids:[],catalog_offer:{product_id:'p',currency:'USD',original_price:'5',discounted_price:'4'}} as unknown as Product;
  const card = assistantProductBlock([product]).products![0];
  expect(card.price).toBe('4'); expect(card.original_price).toBe('5');
  expect(card.route).toBe('/products/p');
});
it('does not fetch a cancelled discovery request', async () => {
  const search=vi.spyOn(catalogApi,'search');
  const controller=new AbortController();controller.abort();
  await expect(discoverAssistantProducts('milk',controller.signal)).rejects.toThrow();
  expect(search).not.toHaveBeenCalled();vi.restoreAllMocks();
});
