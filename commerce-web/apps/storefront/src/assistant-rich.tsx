import { AssistantProductFacts } from "./assistant-product-facts";
import { AssistantCompoundChoice } from "./assistant-compound-choice";
import { useAssistantProductLimit } from './assistant-product-layout';
import { AssistantOrderGuide } from "./assistant-order-guide";
import { useDeliveryKey } from "./locations";
import { AssistantProductGuide, type SelectProductAction } from "./assistant-product-guide";
import { cartPage, completeCartSnapshot, type CartSnapshot } from "./assistant-cart-pagination";
import { ProductPrice } from "./product-price";
import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { cartApi, catalogApi, mediaUrl, wishlistApi, type AssistantBlock } from "@commerce/api-client";
import { AddToCart } from "./cart";
import { useAssistantSelection } from "./assistant-selection";
import { AssistantMarkdown } from "./assistant-markdown";
import { AssistantAddresses } from "./assistant-addresses";
import { BasketProposalCard } from "./shopping";

type Product = NonNullable<AssistantBlock["products"]>[number];

function CompactCartImage({ productId, imageId }: { productId: string; imageId?: string | null }) {
  const product = useQuery({ queryKey: ["cart-product", productId], queryFn: () => catalogApi.product(productId), enabled: !imageId });
  const image = imageId ?? product.data?.media_ids?.[0];
  const [failed, setFailed] = useState(false);
  return <span className="assistant-cart-preview-image">{image && !failed ? <img src={mediaUrl(image)} alt="" onError={() => setFailed(true)} /> : <span aria-hidden="true">◇</span>}</span>;
}

function InlineProductDetails({ productId }: { productId: string }) {
  const product = useQuery({ queryKey: ["cart-product", productId], queryFn: () => catalogApi.product(productId) });
  if (product.isPending) return <p className="assistant-inline-product-details" role="status">Loading product details…</p>;
  if (product.isError || !product.data) return <p className="assistant-inline-product-details" role="status">Product details are unavailable right now.</p>;
  const details = Object.entries(product.data.attributes).map(([name, value]) => ({ name, value }));
  return <div className="assistant-inline-product-details"><AssistantProductFacts facts={[
    { name: 'Unit price', value: `${product.data.price} ${product.data.currency}` },
    { name: 'Unit', value: product.data.unit },
    { name: 'Availability', value: product.data.in_stock === true ? 'In stock' : product.data.in_stock === false ? 'Out of stock' : 'Not provided' },
    ...details,
  ]} /></div>;
}

function CartStatusIcon() {
  return <svg className="assistant-cart-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 3h2l2.4 11.4a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.6L21 7H6" />
    <circle cx="10" cy="20" r="1" /><circle cx="18" cy="20" r="1" />
  </svg>;
}

export type RemoveCartProduct = (id: string, name: string, quantity: number) => void;

function CartRemovalReceipt({ receipt }: { receipt: NonNullable<AssistantBlock["cart_removal"]> }) {
  return <section className="assistant-cart-removal" aria-label="Item removed from cart">
    <CompactCartImage productId={receipt.product_id} />
    <div className="assistant-cart-removal-details">
      <strong className="assistant-cart-removal-status"><CartStatusIcon />Removed from cart</strong>
      <h3>{receipt.name}</h3>
      <p>Quantity removed: {receipt.quantity}{receipt.remaining_quantity > 0 ? ` · ${receipt.remaining_quantity} remaining` : " · All units removed"}</p>
      <small>{receipt.cart_quantity} {receipt.cart_quantity === 1 ? "item" : "items"} in your cart · Subtotal: {receipt.cart_subtotal} {receipt.currency}</small>
    </div>
  </section>;
}

function CartRemovalChoices({ choice, busy, onRemove }: {
  choice: NonNullable<AssistantBlock["cart_removal_choice"]>; busy: boolean; onRemove?: RemoveCartProduct;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [quantity, setQuantity] = useState<number | null>(choice.quantity);
  const locked = busy || submitted || !onRemove;
  const validQuantity = quantity === null || (Number.isInteger(quantity) && quantity >= 1 && quantity <= 1000000);
  if (choice.items.length === 1) {
    const item = choice.items[0];
    const count = choice.quantity ?? item.quantity;
    return <section className="assistant-cart-removal" aria-label="Confirm cart removal">
      <CompactCartImage productId={item.product_id} />
      <div className="assistant-cart-removal-details">
        <strong className="assistant-cart-removal-status"><CartStatusIcon />Remove from cart?</strong>
        <h3>{item.name}</h3>
        <p>Quantity to remove: {count} · {item.price} {item.currency} each</p>
        <button type="button" className="assistant-cart-removal-confirm" disabled={locked || count > item.quantity}
          onClick={() => { setSubmitted(true); onRemove?.(item.product_id, item.name, count); }}>Confirm removal</button>
        {submitted && <p role="status">Confirmation sent. Check the assistant’s reply for the result.</p>}
      </div>
    </section>;
  }
  return <section className="assistant-product-guide" aria-label="Choose an item to remove">
    <h3>Choose a product to remove from your cart</h3>
    <p>Please choose the exact product. Only items in your cart are shown.</p>
    <label className="assistant-guide-quantity">
      <input type="checkbox" checked={quantity === null} disabled={locked}
        onChange={event => setQuantity(event.target.checked ? null : 1)} /> Remove all units
    </label>
    {quantity !== null && <label className="assistant-guide-quantity">Quantity to remove
      <input type="number" min={1} max={1000000} step={1} required value={quantity} disabled={locked}
        onChange={event => setQuantity(Number(event.target.value))} />
      {!validQuantity && <span role="alert">Enter a whole quantity from 1 to 1,000,000.</span>}
    </label>}
    <ul className="assistant-guide-products">{choice.items.map(item => <li key={item.product_id}>
      <CompactCartImage productId={item.product_id} />
      <div><strong>{item.name}</strong><small>{item.quantity} in your cart</small><small>{item.price} {item.currency} each</small></div>
      <button type="button" disabled={locked || !validQuantity || (quantity !== null && quantity > item.quantity)}
        onClick={() => { setSubmitted(true); onRemove?.(item.product_id, item.name, quantity ?? item.quantity); }}>
        {quantity === null ? `Confirm removal of all ${item.quantity}` : `Confirm removal of ${validQuantity ? quantity : ""}`}
      </button>
      {quantity !== null && quantity > item.quantity && <small>Only {item.quantity} in your cart.</small>}
    </li>)}</ul>
    {submitted && <p role="status">Selection sent. Check the assistant’s reply for the result.</p>}
  </section>;
}

function ProductImage({ product }: { product: Product }) {
  const [failed, setFailed] = useState(false);
  return <div className="assistant-rich-image">{product.image_id && !failed ? <img src={mediaUrl(product.image_id)} alt={product.name} loading="lazy" onError={() => setFailed(true)} /> : <span>Image unavailable</span>}</div>;
}
function AssistantCartLine({ item }: { item: NonNullable<AssistantBlock["cart"]>["items"][number] }) {
  const [expanded, setExpanded] = useState(false);
  const selection = useAssistantSelection();
  return <li className="assistant-rich-card assistant-cart-product-card">
    <button type="button" className="assistant-product-select" aria-label={`View ${item.name} details`} disabled={selection?.busy} aria-expanded={expanded} onClick={() => { if (!expanded) selection?.selectProduct({ id: item.product_id, name: item.name }); setExpanded(value => !value); }}>
      <span className="assistant-rich-image"><CompactCartImage productId={item.product_id} /></span>
    </button>
    <div className="assistant-rich-card-body">
      <h4><button type="button" className="assistant-product-name" disabled={selection?.busy} aria-expanded={expanded} onClick={() => { if (!expanded) selection?.selectProduct({ id: item.product_id, name: item.name }); setExpanded(value => !value); }}>{item.name}</button></h4>
      <p className="assistant-rich-price"><ProductPrice price={item.price} currency={item.currency} /></p>
      <p className="assistant-cart-product-quantity">Quantity: {item.quantity}</p>
      <p className="assistant-cart-product-total">Total <strong>{item.line_total} {item.currency}</strong></p>
      {expanded && <InlineProductDetails productId={item.product_id} />}
    </div>
  </li>;
}
export function CartSummary({ cart: original }: { cart: CartSnapshot }) {
  const selection = useAssistantSelection();
  const [refreshed, setRefreshed] = useState<{cart: CartSnapshot; time: string}>();
  const [requestedPage, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const cart = refreshed?.cart ?? original;
  const pagination = cartPage(cart, requestedPage);
  const shown = pagination.items;
  const remaining = cart.total_lines - cart.items.length;
  async function loadCompleteCart() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true); setError("");
    try {
      const current = await cartApi.open();
      setRefreshed({cart: completeCartSnapshot(current), time: new Date().toLocaleTimeString()});
      setPage(0);
    } catch {
      setError("Could not load the complete current cart. Your previous snapshot is still shown. Please retry.");
    } finally { inFlight.current = false; setLoading(false); }
  }
  return <section className="assistant-cart-card" aria-label="Your cart items">
    <header className="assistant-cart-heading"><h3><CartStatusIcon /><button type="button" className="assistant-product-name" disabled={selection?.busy} onClick={selection?.selectCart}>Your cart</button></h3><span>{cart.total_lines} {cart.total_lines === 1 ? "product" : "products"} · {cart.total_quantity} {cart.total_quantity === 1 ? "unit" : "units"}</span></header>
    {cart.items.length ? <ul className="assistant-rich-grid assistant-cart-product-grid">{shown.map(item => <AssistantCartLine item={item} key={item.product_id} />)}</ul> : <p>Your cart is empty. Browse the catalog to add products.</p>}
    {remaining > 0 && <p className="assistant-cart-note">This reply contains {cart.items.length} of {cart.total_lines} products. Load the complete current cart to see every product here.</p>}
    {pagination.pages > 1 && <nav className="assistant-cart-pagination" aria-label="Cart product pages">
      <button type="button" disabled={pagination.page === 0 || loading} onClick={() => setPage(pagination.page - 1)}>Previous</button>
      <span role="status" aria-live="polite">Page {pagination.page + 1} of {pagination.pages} · Products {pagination.start + 1}–{pagination.start + shown.length} of {cart.items.length}{remaining > 0 ? " loaded" : ""}</span>
      <button type="button" disabled={pagination.page + 1 === pagination.pages || loading} onClick={() => setPage(pagination.page + 1)}>Next</button>
    </nav>}
    {(remaining > 0 || refreshed) && <button type="button" className="assistant-cart-refresh" disabled={loading || selection?.busy} onClick={() => void loadCompleteCart()}>{loading ? "Loading current cart…" : error ? "Retry loading current cart" : refreshed ? "Refresh current cart" : "Load complete current cart"}</button>}
    {error && <p role="alert">{error}</p>}
    {refreshed && <p className="assistant-cart-note" role="status">Current cart loaded at {refreshed.time}. All {cart.total_lines} products are available here. This replaces the earlier reply snapshot.</p>}
    {cart.items.length > 0 && <>
      <dl className="assistant-cart-totals"><div><dt>Subtotal</dt><dd>{cart.subtotal} {cart.currency}</dd></div>{Number(cart.discount_amount) > 0 && <div><dt>Current discount</dt><dd>−{cart.discount_amount} {cart.currency}</dd></div>}</dl>
      {!cart.fully_reserved && <p className="assistant-cart-warning">Some items are not currently reserved. Review your cart before checkout.</p>}
      <p className="assistant-cart-note">{refreshed ? "Cart snapshot from the latest refresh." : "Cart snapshot at the time of this reply."} Final tax, delivery and total are shown at checkout.</p>
    </>}
  </section>;
}
function CatalogBlock({ block, busy, onCompare, onRecommend }: { block: AssistantBlock; busy: boolean; onCompare: (routes: string[], names: string[]) => void; onRecommend?: (message: string) => void }) {
  const selection = useAssistantSelection();
  const [detailProductId, setDetailProductId] = useState<string>();
  function selectProduct(product: Product) {
    selection?.selectProduct(product);
    setDetailProductId(current => current === product.id ? undefined : product.id);
  }
  const [selected, setSelected] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string>();
  const [removed, setRemoved] = useState<string[]>([]);
  const [removeError, setRemoveError] = useState("");
  const cache = useQueryClient();
  const products = block.products ?? [];
  const productLimit = useAssistantProductLimit();
  const visibleProducts = products.slice(0, productLimit);
  const manageWishlist = block.kind === "wishlist_manage";
  async function removeSavedItem(id: string) {
    setRemoving(id);
    setRemoveError("");
    try {
      await wishlistApi.remove(id);
      setRemoved(current => current.includes(id) ? current : [...current, id]);
      await cache.invalidateQueries({ queryKey: ["wishlist"] });
    } catch {
      setRemoveError("That item could not be removed. Please retry from your wishlist.");
    } finally {
      setRemoving(undefined);
    }
  }
  return <section className="assistant-rich-catalog" aria-label={block.title}>
    <h3>{block.title}</h3>
    {block.kind === "comparison_table" ? <div className="assistant-rich-table-scroll" tabIndex={0} role="region" aria-label="Product comparison, scroll horizontally for more products"><table className="assistant-rich-table">
      <caption>Current catalog facts · missing attributes are marked “Not provided”. Scroll horizontally to see all products.</caption>
      <thead><tr><th scope="col">Detail</th>{products.map(p => <th scope="col" key={p.id}><ProductImage product={p} /><button type="button" className="assistant-product-name" disabled={busy} onClick={() => selectProduct(p)}>{p.name}</button></th>)}</tr></thead>
      <tbody>{block.rows?.map((row, index) => <tr key={index}><th scope="row">{row.label}</th>{row.values.map((value, i) => <td key={products[i].id}>{value}</td>)}</tr>)}
        <tr><th scope="row">Your cart</th>{products.map(p => <td key={p.id}><div className="assistant-rich-purchase"><AddToCart id={p.id} compact productName={p.name} /></div></td>)}</tr>
      </tbody>
    </table></div> : <div className="assistant-rich-grid">{visibleProducts.map(p => <Fragment key={p.id}><article className="assistant-rich-card">
      {!manageWishlist && products.length > 1 && <button type="button" className="assistant-rich-compare-icon"
        title={`${selected.includes(p.route) ? "Remove from comparison" : "Compare"}: ${p.name}`}
        aria-label={`Compare ${p.name}`} aria-pressed={selected.includes(p.route)}
        disabled={busy || (!selected.includes(p.route) && selected.length >= 5)}
        onClick={() => setSelected(current => current.includes(p.route) ? current.filter(route => route !== p.route) : [...current, p.route])}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />
        </svg>
      </button>}
      <button type="button" className="assistant-product-select" aria-label={`Product details for ${p.name}`} aria-expanded={detailProductId === p.id} disabled={busy} onClick={() => selectProduct(p)}><ProductImage product={p} /></button>
      <div className="assistant-rich-card-body"><h4><button type="button" className="assistant-product-name" aria-expanded={detailProductId === p.id} disabled={busy} onClick={() => selectProduct(p)}>{p.name}</button></h4>
        <p className="assistant-rich-price"><ProductPrice price={p.price} originalPrice={p.original_price} currency={p.currency}/></p>
        {typeof p.in_stock === "boolean" && <p className={`assistant-rich-stock ${p.in_stock ? "available" : ""}`}>{p.in_stock ? "In stock" : "Out of stock"}</p>}
        {p.unmet.length > 0 && <div className="assistant-rich-unmet"><strong>Unmet or unverified</strong><ul>{p.unmet.map((reason, i) => <li key={i}>{reason}</li>)}</ul></div>}
        <div className="assistant-rich-card-controls">
        {manageWishlist ? <button type="button" className="secondary" disabled={busy || removing !== undefined || removed.includes(p.id)} onClick={() => void removeSavedItem(p.id)}>{removed.includes(p.id) ? "Removed from wishlist" : removing === p.id ? "Removing…" : `Confirm removal of ${p.name} from wishlist`}</button> : <div className="assistant-rich-purchase"><AddToCart id={p.id} compact productName={p.name} /></div>}

        </div>
        {p.attributes.length > 0 && <details className="assistant-rich-details" open={detailProductId === p.id}><summary onClick={event => {
          event.preventDefault();
          setDetailProductId(current => current === p.id ? undefined : p.id);
        }}>Product details</summary><AssistantProductFacts facts={p.attributes} /></details>}
      </div>
    </article></Fragment>)}</div>}
    {selected.length > 0 && <section className="assistant-selection-list" aria-label="Products selected for comparison"><h4>Compare list ({selected.length}/5)</h4><ul>{selected.map(route => { const product = products.find(p => p.route === route); return product ? <li key={route}><span>{product.name}</span><button type="button" disabled={busy} aria-label={`Remove ${product.name} from comparison`} onClick={() => setSelected(current => current.filter(value => value !== route))}>Remove</button></li> : null; })}</ul>{selected.length < 2 && <p>Select one more product to compare.</p>}</section>}
    {removeError && <p role="alert">{removeError}</p>}
    {block.kind !== "comparison_table" && !manageWishlist && products.length > 1 && <button className="assistant-rich-compare" disabled={busy || selected.length < 2} onClick={() => onCompare(selected, selected.map(route => products.find(p => p.route === route)!.name))}>Compare selected ({selected.length}/5)</button>}
    {onRecommend && block.kind === "recommendation_group" && <RecommendationShortcuts busy={busy} onRecommend={onRecommend} />}
    {block.kind === "comparison_table" && products.some(p => p.unmet.length) && <ul className="assistant-rich-unmet">{products.filter(p => p.unmet.length).map(p => <li key={p.id}>{p.name}: unmet or unverified — {p.unmet.join(", ")}</li>)}</ul>}
    <p className="assistant-rich-sources">Source: current catalog · {block.sources?.filter(source => block.kind === "comparison_table" || visibleProducts.some(product => product.id === source.product_id)).map((source, i) => <span key={source.product_id}>{i > 0 && " · "}<button type="button" className="assistant-product-name" disabled={busy} onClick={() => selectProduct(products[i])}>{products[i].name}</button></span>)}</p>
  </section>;
}
export function AssistantRichResponse({ blocks, busy, onCompare, customerId, onChooseProduct, onRemoveProduct, onRemoveDestination, onRecommend, onCheckout, onSupport, onCompoundConfirm }: { onCompoundConfirm?: (message: string) => void; onCheckout?: () => void; onSupport?: () => void; blocks: AssistantBlock[]; busy: boolean; onCompare: (routes: string[], names: string[]) => void; customerId?: string; onRecommend?: (message: string) => void; onChooseProduct?: SelectProductAction; onRemoveProduct?: RemoveCartProduct; onRemoveDestination?: (query: string, destination: "cart" | "wishlist", quantity: number) => void }) {
  const delivery = useDeliveryKey();
  const orderPrompts = blocks.flatMap(block => block.kind === 'product_prompt' && block.product_prompt?.action === 'cart' ? [block.product_prompt] : []);
  const firstOrderPrompt = blocks.findIndex(block => block.kind === 'product_prompt' && block.product_prompt?.action === 'cart');
  return <div className="assistant-rich">{blocks.map((block, i) => {
    if (block.kind === 'product_prompt' && block.product_prompt?.action === 'cart' && onChooseProduct) {
      return i === firstOrderPrompt ? <AssistantOrderGuide key={`${i}:${customerId ?? 'guest'}:${delivery}`} prompts={orderPrompts} busy={busy} onChoose={onChooseProduct} onCompare={onCompare} customerId={customerId} /> : null;
    }
    switch (block.kind) {
      case "compound_choice": return block.compound_choice ? <AssistantCompoundChoice key={i} choice={block.compound_choice} busy={busy} onConfirm={onCompoundConfirm} /> : null;
      case "cart_removal": return block.cart_removal ? <CartRemovalReceipt key={i} receipt={block.cart_removal} /> : null;
      case "cart_removal_choice": return block.cart_removal_choice ? <CartRemovalChoices key={i} choice={block.cart_removal_choice} busy={busy} onRemove={onRemoveProduct} /> : null;
      case "product_prompt": return block.product_prompt && onChooseProduct ? <AssistantProductGuide key={i} prompt={block.product_prompt} onRemoveDestination={onRemoveDestination} busy={busy} onChoose={onChooseProduct} onCompare={onCompare} customerId={customerId} /> : null;
      case "text": return <AssistantMarkdown key={i} text={block.text ?? ""} onCheckout={onCheckout} onSupport={onSupport} />;
      case "saved_addresses": return <AssistantAddresses key={`${i}:${customerId ?? "guest"}`} customerId={customerId} />;
      case "basket_proposal": return block.proposal_id ? <BasketProposalCard key={block.proposal_id} id={block.proposal_id} /> : null;
      case "action": return block.action ? <Link key={i} className="assistant-rich-action" to={block.action.route}>{block.action.label} <span className="direction-icon" aria-hidden="true">→</span></Link> : null;
      case "cart_summary": return block.cart ? <CartSummary key={i} cart={block.cart} /> : null;
      case "wishlist_transfer": return <section className="assistant-transfer-card" key={i} aria-label={block.title ?? "Wishlist transfer results"}>
        <h3>{block.title ?? "Wishlist transfer"}</h3>
        <ul>{(block.transfer_items ?? []).map((item, index) => <li key={`${item.name}:${index}`}>
          <span>{item.name}</span>
          <strong className={`assistant-transfer-badge ${item.status}`} role="status">{item.status === "transferred" ? "Transferred" : item.status === "not_confirmed" ? "Not confirmed" : "Could not transfer"}</strong>
          {item.detail && <small>{item.detail}</small>}
        </li>)}</ul>
      </section>;
      case "product_card": case "product_list": case "recommendation_group": case "comparison_table": case "wishlist_manage": return <CatalogBlock key={i} block={block} busy={busy} onCompare={onCompare} onRecommend={onRecommend} />;
      default: return null;
    }
  })}</div>;
}

function SavedProductName({ id }: { id: string }) {
  const product = useQuery({ queryKey: ["assistant-saved-product", id], queryFn: () => catalogApi.product(id) });
  return <li><Link to={`/products/${id}`}>{product.data?.name ?? (product.isError ? "View saved product" : "Loading product…")}</Link></li>;
}

export function AssistantWishlistWatcher({ customerId }: { customerId?: string }) {
  const query = useQuery({ queryKey: ["wishlist", customerId], queryFn: wishlistApi.list, enabled: !!customerId });
  const previous = useRef<string[]>();
  const [visible, setVisible] = useState(false);
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (!query.data) return;
    if (previous.current && query.data.some(id => !previous.current!.includes(id))) { setVisible(true); setPage(0); }
    previous.current = query.data;
  }, [query.data]);
  if (!customerId || !visible) return null;
  const ids = query.data ?? [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(ids.length / 10) - 1));
  return <section className="assistant-selection-list" aria-label="Your updated wishlist"><h3>Your wishlist ({ids.length})</h3>{query.isError ? <p role="alert">Wishlist could not refresh. <button onClick={() => void query.refetch()}>Retry</button></p> : <><ul>{ids.slice(currentPage * 10, currentPage * 10 + 10).map(id => <SavedProductName key={id} id={id} />)}</ul>{!ids.length && <p>Your wishlist is empty.</p>}{ids.length > 10 && <nav aria-label="Wishlist pages"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {Math.ceil(ids.length / 10)}</span><button disabled={(currentPage + 1) * 10 >= ids.length} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}</>}</section>;
}

function RecommendationShortcuts({ busy, onRecommend }: { busy: boolean; onRecommend: (message: string) => void }) {
  const categories = useQuery({ queryKey: ["assistant-recommendation-categories"], queryFn: () => catalogApi.categories(), staleTime: 60000 });
  return <nav className="assistant-recommendation-shortcuts" aria-label="Refine recommendations">
    <button type="button" disabled={busy} onClick={() => onRecommend("Show me something else")}>Something else</button>
    <button type="button" disabled={busy} onClick={() => onRecommend("Show me cheaper options")}>Cheaper options</button>
    {(categories.data ?? []).slice(0, 5).map(category => <button key={category.id} type="button" disabled={busy} onClick={() => onRecommend(`Recommend products in category ${category.name}`)}>{category.name}</button>)}
  </nav>;
}
