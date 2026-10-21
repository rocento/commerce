import { AssistantAddToCart } from './assistant-add-to-cart';
import { useAssistantProductLimit } from './assistant-product-layout';
import { useQueries } from '@tanstack/react-query';
import { discoverAssistantProducts } from './assistant-discovery';
import { CatalogPrice } from './product-price';
import { useDeliveryKey } from './locations';
import { useEffect, useRef, useState } from 'react';
import { cartApi, mediaUrl } from '@commerce/api-client';
import { useCart } from './cart';
import { type ProductPrompt, type SelectProductAction } from './assistant-product-guide';

/** One cart decision covers all product choices in this order request. */
export function AssistantOrderGuide({ prompts, busy, customerId }: {
  prompts: ProductPrompt[]; busy: boolean; onChoose: SelectProductAction;
  onCompare: (routes: string[], names: string[]) => void; customerId?: string;
}) {
  const productLimit = useAssistantProductLimit();
  const { cart, ready, error, syncing, setCart } = useCart();
  const [drafts, setDrafts] = useState(() => prompts.map(prompt => ({...prompt})));
  const [searches, setSearches] = useState(() => prompts.map(prompt => ({...prompt})));
  const [revision, setRevision] = useState(() => prompts.map(() => 0));
  const delivery = useDeliveryKey();
  const matches = useQueries({ queries: searches.map((prompt, index) => ({
    queryKey: ['order-products', prompt.query, delivery, customerId ?? 'guest', revision[index]],
    queryFn: ({signal}: {signal: AbortSignal}) => discoverAssistantProducts(prompt.query, signal),
    retry: false, staleTime: 0,
  })) });
  const dirty = drafts.some((draft, index) => draft.query.trim() !== searches[index].query || draft.quantity !== searches[index].quantity);
  const valid = drafts.every(draft => draft.query.trim() && Number.isInteger(draft.quantity) && draft.quantity >= 1 && draft.quantity <= 1000000);
  const edit = (index: number, change: Partial<ProductPrompt>) => setDrafts(current => current.map((draft, i) => i === index ? {...draft, ...change} : draft));
  const [chosen, setChosen] = useState(false);
  const [cartReply, setCartReply] = useState('');
  const [clearing, setClearing] = useState(false);
  const [failure, setFailure] = useState('');
  const lock = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const needsChoice = !chosen && !!cart?.items.length;
  const blocked = busy || clearing || syncing || !ready || !!error;
  async function clear() {
    if (blocked || lock.current || !cart) return;
    lock.current = true; setClearing(true); setFailure('');
    const displayed = cart;
    try {
      const latest = await cartApi.open();
      if (!active.current) return;
      setCart(latest);
      const signature = (items: typeof latest.items) => JSON.stringify(items.map(item => [item.product_id, item.quantity]).sort());
      if (signature(latest.items) !== signature(displayed.items)) throw new Error('Your cart changed. Review it below and choose again.');
      // Remove only the displayed lines. Never clear newly discovered products.
      for (const item of displayed.items) {
        if (!active.current) return;
        const updated = await cartApi.remove(item.product_id);
        if (!active.current) return;
        setCart(updated);
      }
      const verified = await cartApi.open();
      if (!active.current) return;
      setCart(verified);
      if (verified.items.length) throw new Error('Your cart still contains items. Review it below before continuing.');
      setCartReply('Clear cart and start this order');
      setChosen(true);
    } catch (cause) {
      if (active.current) setFailure(cause instanceof Error ? `Could not finish clearing the cart. ${cause.message}` : 'Could not finish clearing the cart. Review your remaining items and retry.');
    } finally {
      lock.current = false;
      if (active.current) setClearing(false);
    }
  }
  if (!ready || error || needsChoice || clearing || failure) return <article className="assistant-product-guide assistant-cart-decision" aria-label="Choose what to do with your cart">
    <h3>Keep your current cart or start fresh?</h3>
      {!ready && !error && <p role="status">Checking your current cart…</p>}
      {error && <p role="alert">Could not check your cart. Please wait for it to refresh.</p>}
      {failure && <p role="alert">{failure}</p>}
      {(needsChoice || !!failure) && <>
        <p>Your cart currently contains:</p>
        <ul>{cart?.items.map(item => <li key={item.product_id}>{item.quantity} × {item.name}</li>)}</ul>
        {!cart?.items.length && <p>No remaining items.</p>}
        <div className="assistant-guide-actions">
          <button type="button" disabled={blocked} onClick={() => { setCartReply('Keep current cart and add products'); setChosen(true); setFailure(''); }}>Keep current cart and add products</button>
          <button type="button" disabled={blocked} onClick={() => void clear()}>{clearing ? 'Clearing cart…' : 'Clear cart and start this order'}</button>
        </div>
      </>}
  </article>;
  return <div className="assistant-order-conversation">
    {cartReply && <>
      <article className="assistant-order-choice-reply" aria-label="Your cart choice"><strong>You</strong><p>{cartReply}</p></article>
      <p className="assistant-order-next-speaker">Rocento assistant</p>
    </>}
    <section className="assistant-product-guide assistant-order-guide" aria-label="Plan your order">
      <h3>Let’s build your order</h3>
      <p>Find your products together, then choose a matching card for each item. Quantities use each product’s listed unit.</p>
      <form className="assistant-order-search" onSubmit={event => {
        event.preventDefault();
        if (busy || clearing || !valid) return;
        setSearches(drafts.map(draft => ({...draft, query: draft.query.trim()})));
        setRevision(current => current.map(value => value + 1));
      }}>
        <div className="assistant-order-inputs">{drafts.map((draft, index) => <div className="assistant-order-input-row" key={index}>
          <label>Product {index + 1}
            <input aria-label={`Search product ${index + 1}`} value={draft.query} maxLength={120} required disabled={busy || clearing} onChange={event => edit(index, {query:event.target.value})} />
          </label>
          <label>Quantity
            <input aria-label={`Quantity for product ${index + 1}`} type="number" min={1} max={1000000} step={1} required value={draft.quantity} disabled={busy || clearing} onChange={event => edit(index, {quantity:Number(event.target.value)})} />
          </label>
        </div>)}</div>
        <button type="submit" disabled={busy || clearing || !valid}>Find products</button>
      </form>
      {dirty && <p role="status">Select Find products to update the matching cards.</p>}
      {matches.map((result, index) => <div key={index}>
        {result.isPending && <p role="status">Finding “{searches[index].query}”…</p>}
        {result.isError && <p role="alert">Could not load “{searches[index].query}”. Use Find products to retry.</p>}
        {result.isSuccess && !result.data.length && <p>No matches for “{searches[index].query}”. Edit its search above and try again.</p>}
      </div>)}
      <ul className="assistant-rich-grid assistant-order-products">{matches.flatMap((result, index) => result.isError ? [] : (result.data ?? []).slice(0, productLimit).map(product => <li className="assistant-rich-card assistant-order-product" key={`${index}:${product.id}`}>
        <div className="assistant-rich-image">{product.media_ids[0] ? <img src={mediaUrl(product.media_ids[0])} alt="" loading="lazy" /> : <span>Image unavailable</span>}</div>
        <div className="assistant-rich-card-body">
          <small>For “{searches[index].query}” · {searches[index].quantity} requested</small>
          <h4>{product.name}</h4>
          <small>SKU: {product.sku} · {product.unit}</small>
          <div className="assistant-rich-price"><CatalogPrice product={product} /></div>
          <p className={`assistant-rich-stock ${product.in_stock ? 'available' : ''}`}>{product.in_stock ? 'In stock' : 'Out of stock'}</p>
          <div className="assistant-rich-card-controls"><AssistantAddToCart id={product.id} name={product.name} quantity={searches[index].quantity}
            disabled={blocked || needsChoice || !!failure || dirty || result.isFetching || !product.in_stock}
            onAdding={() => setChosen(true)} /></div>
        </div>
      </li>))}</ul>
    </section>
  </div>;
}
