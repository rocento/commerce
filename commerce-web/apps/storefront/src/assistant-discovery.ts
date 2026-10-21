import { catalogApi, attributeApi, type Product, type AssistantBlock } from '@commerce/api-client';
import { catalogPrice } from './catalog-price';
const key = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');

/** Shared read-only discovery for assistant browsing, guided selection and order item choices.
 * Preserve the full query for name/SKU/attribute search; category expansion only uses an exact identity.
 * Fuzzy hits are suggestions, never authorization to add or remove a product.
 */
export async function discoverAssistantProducts(query: string, signal?: AbortSignal, savedIds?: string[]): Promise<Product[]> {
  signal?.throwIfAborted();
  const [result, categories] = await Promise.all([
    catalogApi.search({ q: query }, signal),
    catalogApi.categories().catch(() => []),
  ]);
  signal?.throwIfAborted();
  const matchedCategories = categories.filter(c => key(c.name) === key(query) || key(c.slug) === key(query));
  const categoryProducts = matchedCategories.length === 1
    ? (await catalogApi.search({ category_id: matchedCategories[0].id }, signal)).hits : [];
  const all = [...new Map([...result.hits, ...categoryProducts].map(product => [product.id, product])).values()];
  const families = await Promise.all(all.filter(p => p.product_type === 'configurable').slice(0, 5)
    .map(p => attributeApi.family(p.id)));
  signal?.throwIfAborted();
  const selectable = [...new Map([...all, ...families.flatMap(f => f.children)]
    .filter(p => p.active && p.product_type === 'simple').map(p => [p.id, p])).values()];
  // Fuzzy matches are suggestions, never authority for a product change.
  const score = (p: Product) => query.trim() && key(p.sku) === key(query) ? 0 : query.trim() && key(p.name) === key(query) ? 1 : 2;
  return selectable.filter(p => !savedIds || savedIds.includes(p.id)).sort((a, b) => score(a) - score(b)).slice(0, 8);
}

export function assistantProductBlock(products: Product[]): AssistantBlock {
  return {kind: 'product_list', products: products.map(product => {
    const price = catalogPrice(product);
    return {id: product.id, name: product.name, image_id: product.media_ids?.[0] ?? null,
      price: price.price, original_price: price.originalPrice, currency: product.currency,
      in_stock: product.in_stock, route: `/products/${product.id}`, attributes: [], reasons: [], unmet: []};
  })};
}
