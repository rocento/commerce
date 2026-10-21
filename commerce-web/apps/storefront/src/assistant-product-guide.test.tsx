import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { catalogApi, attributeApi, wishlistApi, type Product, type Category } from '@commerce/api-client';
import { AssistantProductGuide, findGuidedProducts } from './assistant-product-guide';
vi.mock('./locations', () => ({ useDeliveryKey: () => 'test-location', useDeliveryStatus: () => ({ data: { configured: true } }) }));
const product = (id: string, name: string, sku = id): Product => ({
  id, name, sku, slug: id, description: '', price: '2.00', currency: 'USD', unit: 'pack', category_id: 'fruit',
  attributes: {}, media_ids: [], active: true, in_stock: true, updated_at: '', product_type: 'simple',
  parent_id: null, variant_attributes: {}, attribute_set_id: null,
});
const results = (hits: Product[]) => ({ hits, total: hits.length, offset: 0, limit: 20 });
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(catalogApi, 'categories').mockResolvedValue([]);
  vi.spyOn(attributeApi, 'family').mockResolvedValue({children: []} as unknown as Awaited<ReturnType<typeof attributeApi.family>>);
});
it('waits for an action before fetching products or offering a write', () => {
  const search = vi.spyOn(catalogApi, 'search');
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <AssistantProductGuide prompt={{query: 'banans', quantity: 1, action: 'choose'}} busy={false} onChoose={vi.fn()} onCompare={vi.fn()} />
  </QueryClientProvider>);
  expect(html).toContain('banans');
  for (const label of ['Add to cart', 'Save to wishlist', 'Compare']) expect(html).toContain(label);
  expect(html).not.toContain('Quantity to add');
  expect(search).not.toHaveBeenCalled();
});
it('preserves the typo query and returns catalog identities, not guessed names', async () => {
  const banana = product('p1', 'Bananas 1kg');
  const search = vi.spyOn(catalogApi, 'search').mockResolvedValue(results([banana]));
  expect(await findGuidedProducts('banans')).toEqual([banana]);
  expect(search).toHaveBeenCalledWith({ q: 'banans' }, undefined);
});
it('prioritizes an exact SKU over a fuzzy name match', async () => {
  const exact = product('p2', 'Bananas 1kg', 'FR-001');
  vi.spyOn(catalogApi, 'search').mockResolvedValue(results([product('p1', 'FR-001'), exact]));
  expect((await findGuidedProducts('fr-001'))[0]).toEqual(exact);
});
it('expands an exact category through its id and deduplicates products', async () => {
  vi.mocked(catalogApi.categories).mockResolvedValue([{id: 'fruit', name: 'Fresh Fruit', slug: 'fresh-fruit'} as Category]);
  const one = product('p1', 'Bananas');
  const two = product('p2', 'Apples');
  const search = vi.spyOn(catalogApi, 'search').mockResolvedValueOnce(results([one])).mockResolvedValueOnce(results([one, two]));
  expect(await findGuidedProducts('Fresh Fruit')).toEqual([one, two]);
  expect(search).toHaveBeenLastCalledWith({category_id: 'fruit'}, undefined);
});
it('returns a bounded set of selectable products without configurable parents', async () => {
  const products = Array.from({length: 11}, (_, i) => product(String(i), `Product ${i}`));
  products[0].product_type = 'configurable';
  vi.spyOn(catalogApi, 'search').mockResolvedValue(results(products));
  expect((await findGuidedProducts('product')).map(p => p.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
});
it('retains name search when category metadata is unavailable but does not hide search errors', async () => {
  vi.mocked(catalogApi.categories).mockRejectedValue(Error('category unavailable'));
  const item = product('p1', 'Bananas');
  vi.spyOn(catalogApi, 'search').mockResolvedValueOnce(results([item])).mockRejectedValueOnce(Error('search unavailable'));
  expect(await findGuidedProducts('banans')).toEqual([item]);
  await expect(findGuidedProducts('banans')).rejects.toThrow('search unavailable');
});

it('offers removal destinations without catalog fetching or add actions', () => {
  const search = vi.spyOn(catalogApi, 'search');
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <AssistantProductGuide prompt={{query: 'banaa', quantity: 1, action: 'remove'}} busy={false}
      onChoose={vi.fn()} onCompare={vi.fn()} onRemoveDestination={vi.fn()} />
  </QueryClientProvider>);
  expect(html).toContain('banaa');
  expect(html).toContain('Remove from cart');
  expect(html).toContain('Remove from wishlist');
  expect(html).not.toContain('Add to cart');
  expect(html).not.toContain('Compare');
  expect(search).not.toHaveBeenCalled();
});

it('offers cart, wishlist and compare for all-item removal without changing anything', () => {
  const remove = vi.spyOn(wishlistApi, 'remove');
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <AssistantProductGuide prompt={{query: 'all items', quantity: 1, action: 'remove'}} busy={false}
      onChoose={vi.fn()} onCompare={vi.fn()} onRemoveDestination={vi.fn()} />
  </QueryClientProvider>);
  for (const label of ['Cart', 'Wishlist', 'Compare']) expect(html).toContain(`>${label}</button>`);
  expect(remove).not.toHaveBeenCalled();
});

it('expands configurable mangoes into selectable pack sizes', async () => {
  const parent = {...product('mango', 'Mangoes'), product_type: 'configurable' as const};
  const pack = {...product('mango-500', 'Mangoes 500g'), parent_id: parent.id};
  vi.spyOn(catalogApi, 'search').mockResolvedValue(results([parent]));
  vi.mocked(attributeApi.family).mockResolvedValue({children: [pack]} as unknown as Awaited<ReturnType<typeof attributeApi.family>>);
  expect(await findGuidedProducts('mangoes')).toEqual([pack]);
});
it('hides destination choices when cart was already specified', () => {
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <AssistantProductGuide prompt={{query: 'mangoes', quantity: 1, action: 'cart'}} busy={false} onChoose={vi.fn()} onCompare={vi.fn()} />
  </QueryClientProvider>);
  expect(html).not.toContain('Product action');
  expect(html).not.toContain('Save to wishlist');
  expect(html).toContain('Choose a product to add to your cart');
});

it('restricts partial removal suggestions to saved products before limiting matches', async () => {
  const products = Array.from({length: 11}, (_, i) => product(String(i), `Yogurt ${i}`));
  vi.spyOn(catalogApi, 'search').mockResolvedValue(results(products));
  expect((await findGuidedProducts('Yogurt', undefined, ['6'])).map(p => p.id)).toEqual(['6']);
});

it('shows a matching wishlist product with explicit confirmation without removing it', () => {
  const cache = new QueryClient();
  cache.setQueryData(['guided-wishlist-removal', 'Yogurt', 'test-location', 'customer'], [product('yogurt', 'Plain Yogurt 500g')]);
  const remove = vi.spyOn(wishlistApi, 'remove');
  const html = renderToStaticMarkup(<QueryClientProvider client={cache}>
    <AssistantProductGuide prompt={{query: 'Yogurt', quantity: 1, action: 'remove'}} busy={false}
      customerId="customer" onChoose={vi.fn()} onCompare={vi.fn()} onRemoveDestination={vi.fn()} />
  </QueryClientProvider>);
  expect(html).toContain('Confirm removal of Plain Yogurt 500g from wishlist');
  expect(html).toContain('No items have been removed');
  expect(remove).not.toHaveBeenCalled();
  cache.clear();
});

it('renders bounded quantity stepper with the requested count', () => {
  const cache = new QueryClient();
  cache.setQueryData(['guided-products', 'lemons', 'test-location', 'guest'], [product('lemons', 'Lemons 500g')]);
  const html = renderToStaticMarkup(<QueryClientProvider client={cache}>
    <AssistantProductGuide prompt={{query: 'lemons', quantity: 5, action: 'cart'}} busy={false} onChoose={vi.fn()} onCompare={vi.fn()} />
  </QueryClientProvider>);
  expect(html).toContain('aria-label="Decrease quantity"');
  expect(html).toContain('aria-label="Increase quantity"');
  expect(html).toContain('value="5"');
  expect(html).toContain('Add 5 to cart');
  cache.clear();
});
