import { AssistantAddToCart } from './assistant-add-to-cart';
import { useAssistantProductLimit } from './assistant-product-layout';
import { discoverAssistantProducts as findGuidedProducts } from './assistant-discovery';
export { discoverAssistantProducts as findGuidedProducts } from './assistant-discovery';
import { useComparison } from "./comparison";
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { wishlistApi, mediaUrl, type AssistantBlock, type Product } from '@commerce/api-client';
import { CatalogPrice } from './product-price';
import { useDeliveryKey } from './locations';
import './assistant-product-guide.css';

export type ProductPrompt = NonNullable<AssistantBlock['product_prompt']>;
export type ProductAction = 'cart' | 'wishlist';
export type SelectProductAction = (id: string, name: string, action: ProductAction, quantity: number) => void;
const key = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');

export function AssistantProductGuide({ prompt, busy, onChoose, onCompare, customerId, onRemoveDestination }: {
  prompt: ProductPrompt;
  busy: boolean;
  onChoose: SelectProductAction;
  onCompare: (routes: string[], names: string[]) => void;
  customerId?: string;
  onRemoveDestination?: (query: string, destination: "cart" | "wishlist", quantity: number) => void;
}) {
  const productLimit = useAssistantProductLimit();
  const comparison = useComparison();
  const cache = useQueryClient();
  const removalLock = useRef(false);
  const [removalStatus, setRemovalStatus] = useState('');
  const [action, setAction] = useState(prompt.action);
  const [query, setQuery] = useState(prompt.query);
  const [draft, setDraft] = useState(prompt.query);
  const [quantity, setQuantity] = useState(prompt.quantity);
  const [submitted, setSubmitted] = useState(false);
  const delivery = useDeliveryKey();
  const scope = `${delivery}:${customerId ?? 'guest'}`;
  const [selection, setSelection] = useState<{scope: string; products: Product[]}>({scope, products: []});
  const selectedProducts = selection.scope === scope ? selection.products : [];
  const selected = selectedProducts.map(product => product.id);
  const clearSelection = () => setSelection({scope, products: []});
  const clearVersion = comparison?.clearVersion;
  useEffect(() => { setSelection(current => ({ ...current, products: [] })); }, [clearVersion]);
  const candidates = useQuery({
    queryKey: ['guided-products', query, delivery, customerId ?? 'guest'],
    queryFn: ({ signal }) => findGuidedProducts(query, signal),
    enabled: action !== 'choose' && action !== 'remove', retry: false, staleTime: 0,
  });
  const savedMatches = useQuery({
    queryKey: ['guided-wishlist-removal', query, delivery, customerId],
    queryFn: async ({ signal }) => {
      const ids = await wishlistApi.list();
      return ids.length ? findGuidedProducts(query, signal, ids) : [];
    },
    enabled: action === 'remove' && key(query) !== 'all items' && !!customerId,
    retry: false, staleTime: 0,
  });
  async function confirmSavedRemoval(product: Product) {
    if (removalLock.current || locked) return;
    removalLock.current = true;
    setSubmitted(true);
    try {
      await wishlistApi.remove(product.id);
      setRemovalStatus(`Removed ${product.name} from your wishlist.`);
      void cache.invalidateQueries({ queryKey: ['wishlist'] });
    } catch { setRemovalStatus('Could not confirm removal. Please check your wishlist before trying again.'); }
  }
  const products = candidates.isError ? [] : (candidates.data ?? []).slice(0, productLimit);
  const locked = busy || submitted;
  const selecting = locked || candidates.isFetching;
  const validQuantity = Number.isInteger(quantity) && quantity >= 1 && quantity <= 1000000;

  const removeAll = key(query) === 'all items';
  if (action === 'remove') return <section className="assistant-product-guide" aria-label="Choose where to remove a product">
    {!removeAll && customerId && <>
      {savedMatches.isFetching && <p role="status">Checking your wishlist for matching products…</p>}
      {savedMatches.isError && <p role="alert">Could not load wishlist matches. <button type="button" disabled={locked} onClick={() => void savedMatches.refetch()}>Retry</button></p>}
      {!!savedMatches.data?.length && <>
        <h3>Remove a matching product from your wishlist?</h3>
        <p>No items have been removed. Confirm the exact product below.</p>
        <ul className="assistant-rich-grid">{savedMatches.data.slice(0, productLimit).map(product => <li className="assistant-rich-card" key={product.id}>
          <div className="assistant-rich-image">{product.media_ids?.[0] ? <img src={mediaUrl(product.media_ids[0])} alt="" /> : <span>Image unavailable</span>}</div>
          <div className="assistant-rich-card-body"><h4>{product.name}</h4>
            <small>SKU: {product.sku}</small>
            <div className="assistant-rich-price"><CatalogPrice product={product} /></div>
            <button type="button" disabled={locked || savedMatches.isFetching} onClick={() => void confirmSavedRemoval(product)}>Confirm removal of {product.name} from wishlist</button>
          </div>
        </li>)}</ul>
      </>}
    </>}
    <h3>Where would you like to remove “{query}” from?</h3>
    <div className="assistant-guide-actions" role="group" aria-label="Remove product from">
      {(removeAll ? ['cart', 'wishlist', 'compare'] as const : ['cart', 'wishlist'] as const).map(destination => <button type="button" key={destination}
        disabled={locked || !onRemoveDestination} onClick={async () => {
          if (removalLock.current) return;
          removalLock.current = true;
          setSubmitted(true);
          if (removeAll && destination === 'compare') {
            if (comparison) { comparison.clear(); setRemovalStatus('All items removed from comparison.'); }
            else setRemovalStatus('Comparison is unavailable. Please open the comparison page to clear it.');
          } else if (removeAll && destination === 'wishlist') {
            try {
              if (!customerId) { setRemovalStatus('Please sign in to clear your wishlist.'); return; }
              const ids = await wishlistApi.list();
              for (const id of ids) await wishlistApi.remove(id);
              const remaining = await wishlistApi.list();
              setRemovalStatus(remaining.length ? 'Some items remain in your wishlist. Please check it before retrying.' : 'Your wishlist is empty.');
            } catch { setRemovalStatus('Could not confirm all removals. Please check your wishlist before retrying.'); }
            finally { void cache.invalidateQueries({ queryKey: ['wishlist'] }); }
          } else if (destination !== 'compare') onRemoveDestination?.(query, destination, quantity);
        }}>{removeAll ? destination === 'cart' ? 'Cart' : destination === 'wishlist' ? 'Wishlist' : 'Compare' : `Remove from ${destination}`}</button>)}
    </div>
    {submitted && <p role="status">{removalStatus || 'Selection sent. Check the assistant’s reply for the result.'}</p>}
  </section>;

  return <section className="assistant-product-guide" aria-label="Choose a product and action">
    <h3>{action === 'choose' ? `What would you like to do with “${query}”?`
      : action === 'compare' ? 'Choose products to compare'
      : action === 'cart' ? 'Choose a product to add to your cart' : 'Choose a product to save to your wishlist'}</h3>
    {prompt.action === 'choose' && <div className="assistant-guide-actions" role="group" aria-label="Product action">
      {([['cart', 'Add to cart'], ['wishlist', 'Save to wishlist'], ['compare', 'Compare']] as const).map(([value, label]) =>
        <button type="button" key={value} aria-pressed={action === value} disabled={locked}
          onClick={() => { setAction(value); clearSelection(); }}>{label}</button>)}
    </div>}
    {action !== 'choose' && <>
      <form className="assistant-guide-search" onSubmit={event => {
        event.preventDefault();
        if (!locked && draft.trim()) { setQuery(draft.trim()); }
      }}>
        <label>Product name, SKU, category or attributes
          <input value={draft} maxLength={120} required disabled={locked} onChange={event => setDraft(event.target.value)} />
        </label>
        <button type="submit" disabled={locked || !draft.trim()}>Find products</button>
      </form>
      {candidates.isPending && <p role="status">Finding matching products…</p>}
      {candidates.isError && <p role="alert">Products could not be loaded. <button type="button" disabled={locked}
        onClick={() => void candidates.refetch()}>Retry</button></p>}
      {!candidates.isPending && !candidates.isError && !products.length &&
        <p>No matching products found for “{query}”. Try a product name, SKU, category or attributes above.</p>}
      {products.length > 0 && <>
        <p>Possible matches for “{query}”. Please choose the exact product.</p>
        {action === 'cart' && <label className="assistant-guide-quantity">Quantity to add
          <span className="assistant-guide-stepper">
            <button type="button" aria-label="Decrease quantity" disabled={locked || !validQuantity || quantity <= 1}
              onClick={() => setQuantity(value => Math.max(1, value - 1))}>−</button>
            <input type="number" min={1} max={1000000} step={1} required value={quantity} disabled={locked}
              onChange={event => setQuantity(Number(event.target.value))} />
            <button type="button" aria-label="Increase quantity" disabled={locked || !validQuantity || quantity >= 1000000}
              onClick={() => setQuantity(value => Math.min(1000000, value + 1))}>+</button>
          </span>
          {!validQuantity && <span role="alert">Enter a whole quantity from 1 to 1,000,000.</span>}
        </label>}
        <ul className="assistant-rich-grid">{products.map(product => <li className="assistant-rich-card" key={product.id}>
          <div className="assistant-rich-image">{product.media_ids[0] ? <img src={mediaUrl(product.media_ids[0])} alt="" loading="lazy" /> : <span>Image unavailable</span>}</div>
          <div className="assistant-rich-card-body">
            <h4>{product.name}</h4>
            <small className="assistant-guide-card-sku">SKU: {product.sku} · {product.unit}</small>
            <div className="assistant-rich-price"><CatalogPrice product={product} /></div>
            <p className={`assistant-rich-stock ${product.in_stock ? 'available' : ''}`}>{product.in_stock ? 'In stock' : 'Out of stock'}</p>
          <div className="assistant-rich-card-controls">
          {action === 'compare' ? <label>
            <input type="checkbox" aria-label={`Compare ${product.name}`} checked={selected.includes(product.id)}
              disabled={selecting || (!selected.includes(product.id) && selectedProducts.length >= 5)}
              onChange={() => setSelection({scope, products: selected.includes(product.id)
                ? selectedProducts.filter(p => p.id !== product.id) : [...selectedProducts, product]})} />
            <span>Compare</span>
          </label> : action === 'cart' ? <AssistantAddToCart id={product.id} name={product.name} quantity={quantity} disabled={locked || !validQuantity || !product.in_stock} /> : <button type="button"
            disabled={selecting}
            onClick={() => { setSubmitted(true); onChoose(product.id, product.name, action as ProductAction, quantity); }}>
            Save to wishlist
          </button>}
          </div></div>
        </li>)}</ul>
      </>}
      {action === 'compare' && <div className="assistant-guide-comparison">
        <p>Choose two to five products. You can search again to find another product.</p>
        {selectedProducts.length > 0 && <ul aria-label="Selected products">{selectedProducts.map(product => <li key={product.id}>
          {product.name} <button type="button" disabled={locked} aria-label={`Remove ${product.name} from comparison`}
            onClick={() => setSelection({scope, products: selectedProducts.filter(p => p.id !== product.id)})}>Remove</button>
        </li>)}</ul>}
        <button type="button" disabled={selecting || selectedProducts.length < 2} onClick={() => {
          setSubmitted(true);
          onCompare(selectedProducts.map(p => `/products/${p.id}`), selectedProducts.map(p => p.name));
        }}>Compare selected ({selectedProducts.length}/5)</button>
      </div>}
      {submitted && <p role="status">Selection sent. Check the assistant’s reply for the result.</p>}
    </>}
  </section>;
}
