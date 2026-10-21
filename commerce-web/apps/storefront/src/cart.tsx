import { ProductRelationships } from "./product-relationships";
import { shoppingLocationKey } from './interface-routing';
import { useInterface } from './interface-locale';
import { useAssistantDelivery } from "./assistant-delivery-context";
import { subtractMoney } from './market-money';
import {useDeliveryKey,useDeliveryStatus} from "./locations";
import { track } from "./analytics";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CartQuantityQueue, cartQuantityCount } from "./cart-quantity";
import { useTheme, themeOptions } from "./themes";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cartApi,
  catalogApi,
  mediaUrl,
  inventoryApi,
  type Cart,
  type CartItem,
  type AppliedDiscount,
} from "@commerce/api-client";
import { Notice, useAction } from "@commerce/ui";
import "./cart.css";
const Context = createContext<{
  cart?: Cart;
  error?: Error | null;
  ready: boolean;
  syncing: boolean;
  quantities: ReturnType<CartQuantityQueue['getSnapshot']>['pending'];
  quantityErrors: Readonly<Record<string, string>>;
  changeQuantity: (id: string, delta: number, available: number) => void;
  setCart: (cart: Cart) => void;
}>({ ready: false, syncing: false, quantities: {}, quantityErrors: {}, changeQuantity: () => {}, setCart: () => {} });
export function CartProvider({
  customerId,
  ready,
  children,
}: {
  customerId?: string;
  ready: boolean;
  children: ReactNode;
}) {
  const delivery=useDeliveryKey();
  const cache = useQueryClient();
  const key = useMemo(() => ["cart", customerId ?? "guest", delivery], [customerId, delivery]);
  const queue = useMemo(() => new CartQuantityQueue({
    read: () => cache.getQueryData<Cart>(key),
    write: cart => { cache.setQueryData(key, cart); },
    // PUT sets an absolute quantity and also creates missing cart lines.
    // The cart is already open, so this avoids add()'s extra open request.
    save: async (id, quantity) => {
      const previous = cache.getQueryData<Cart>(key)?.items.find(item => item.product_id === id)?.quantity ?? 0;
      const cart = await (quantity === 0 ? cartApi.remove(id) : cartApi.update(id, quantity));
      if (quantity > previous) {
        track('cart_added', '/cart');
      }
      return cart;
    },
    refresh: cartApi.open,
    start: () => { void cache.cancelQueries({ queryKey: key, exact: true }); },
    settled: ids => {
      void cache.invalidateQueries({ predicate: query =>
        (query.queryKey[0] === 'stock' && ids.includes(String(query.queryKey[1]))) ||
        ['catalog-search', 'inventory'].includes(String(query.queryKey[0])),
      });
    },
  }), [cache, key]);
  const changes = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const syncing = Object.keys(changes.pending).length > 0;
  useEffect(() => { queue.resume(); return queue.dispose; }, [queue]);
  const q = useQuery({
    queryKey: key,
    queryFn: cartApi.open,
    enabled: ready && !syncing,
    staleTime: 5000,
    refetchInterval: 5000,
  });
  const marketRevision = useRef<string>();
  useEffect(() => {
    if (!q.data?.market) return;
    const next = `${q.data.market.revision}:${q.data.market.store_revision}`;
    if (marketRevision.current && marketRevision.current !== next) {
      void cache.invalidateQueries({ predicate: query => query.queryKey[0] !== 'cart' });
    }
    marketRevision.current = next;
  }, [q.data?.market, cache]);
  return (
    <Context.Provider
      value={{
        cart: q.data,
        error: q.error,
        ready: !!q.data,
        syncing,
        quantities: changes.pending,
        quantityErrors: changes.errors,
        changeQuantity: queue.change,
        setCart: (cart) => {
          cache.setQueryData(key, cart);
          void cache.invalidateQueries({
            predicate: (q) =>
              ["stock", "catalog-search", "inventory"].includes(
                String(q.queryKey[0]),
              ),
          });
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export const useCart = () => useContext(Context);
export function StoreMarketLabel() {
  const {cart}=useCart();
  if (!cart?.market?.id) return null;
  const name=cart.market.country==='EG'?'Egypt':cart.market.country==='US'?'United States':cart.market.country;
  return <span className="store-market-label" aria-label="Store market">{name} · {cart.market.currency}</span>;
}
export function CartLink({ iconOnly = false }: { iconOnly?: boolean }) {
  const { t: ui } = useInterface();
  const theme = useTheme();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebar = themeOptions(theme, 'header_options', 'top').cart_display !== 'page_only' && !location.pathname.startsWith('/assistant') && location.pathname !== '/cart';
  const shoppingKey = shoppingLocationKey(location.pathname, location.search);
  useEffect(() => { setDrawerOpen(false); }, [shoppingKey, sidebar]);
  const { cart, quantities } = useContext(Context);
  const count = cartQuantityCount(cart, quantities);
  const previousCount = useRef(count);
  const [updateKey, setUpdateKey] = useState(0);
  useEffect(() => {
    if (count > previousCount.current) setUpdateKey(key => key + 1);
    previousCount.current = count;
  }, [count]);
  return (
    <><Link className={`cart-link${iconOnly ? " header-action" : ""}${updateKey ? " is-updated" : ""}`} to="/cart" aria-label={iconOnly ? `${ui("storefront.cart", "Cart")} ${count}` : undefined} title={iconOnly ? ui("storefront.cart", "Cart") : undefined} aria-haspopup={sidebar ? 'dialog' : undefined}
      onClick={event => { if (sidebar && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); setDrawerOpen(true); } }}>
      <svg className="cart-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 4h2l2.2 10.3a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L20.5 8H6" />
        <circle cx="10" cy="20" r="1" />
        <circle cx="18" cy="20" r="1" />
      </svg>
      {!iconOnly && ui("storefront.cart", "Cart")} <span key={updateKey} aria-hidden={iconOnly || undefined}>{count}</span>
    </Link>{drawerOpen && <CartDrawer onClose={() => setDrawerOpen(false)} />}</>
  );
}
function CartCloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}
function CartDrawer({ onClose }: { onClose: () => void }) {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const dialog = useRef<HTMLDialogElement>(null);
  const { cart, ready, error, syncing, quantities, quantityErrors, changeQuantity } = useCart();
  useEffect(() => {
    const element = dialog.current!;
    const previousOverflow = document.body.style.overflow;
    element.showModal(); document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = previousOverflow; };
  }, []);
  return <dialog ref={dialog} className="store-cart-drawer" aria-labelledby="store-cart-title" onCancel={onClose}
    onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <header><div><h2 id="store-cart-title">{ui("cart.title", "Your cart")}</h2><span>{ui("cart.item_count", "{count} items", {count:cartQuantityCount(cart, quantities)})}</span></div><button type="button" className="drawer-close icon-button" aria-label={ui("storefront.close_cart", "Close cart")} onClick={onClose}><CartCloseIcon /></button></header>
    <section className="store-cart-drawer-items" aria-label={ui("storefront.cart_items", "Cart items")}>
      <Notice error>{message((error?.message || Object.values(quantityErrors).join(' ')) || '')}</Notice>
      {!ready && !error && <p role="status">{ui("storefront.loading_your_cart", "Loading your cart…")}</p>}
      {ready && !cart?.items.length && <div className="drawer-empty"><h3>{ui("cart.empty", "Your cart is empty")}</h3><p>{ui("storefront.add_something_you_love_to_get_started", "Add something you love to get started.")}</p><button type="button" className="secondary" onClick={onClose}>{ui("cart.continue_shopping", "Continue shopping")}</button></div>}
      {cart?.items.map(item => <article className="drawer-cart-item" key={item.product_id}>
        <DrawerProductImage id={item.product_id} name={item.name} />
        <div className="drawer-product-details"><Link to={`/products/${item.product_id}`}><CartProductName id={item.product_id} fallback={item.name}/></Link><small>{item.price} {cart.currency} / {item.unit}</small></div>
        <button type="button" className="cart-remove icon-button" aria-label={ui("common.remove", "Remove")} title={`${ui("common.remove", "Remove")}: ${item.name}`} disabled={syncing} onClick={() => changeQuantity(item.product_id, -item.quantity, item.available)}><CartCloseIcon /></button>
          <div className="drawer-item-actions"><div className="drawer-quantity" role="group" aria-label={ui("cart.quantity_for", "Quantity for {name}", {name:item.name})}>
            <button type="button" aria-label={ui("cart.decrease_product", "Decrease {name}", {name:item.name})} disabled={syncing} onClick={() => changeQuantity(item.product_id, -1, item.available)}>−</button>
            <output aria-label={ui("storefront.quantity_in_cart", "Quantity in cart")}>{quantities[item.product_id]?.quantity ?? item.quantity}</output>
            <button type="button" aria-label={ui("cart.increase_product", "Increase {name}", {name:item.name})} disabled={syncing || item.quantity >= item.available} onClick={() => changeQuantity(item.product_id, 1, item.available)}>+</button>
          </div><strong className="drawer-line-total">{item.line_total} {cart.currency}</strong></div>
          {item.reserved_quantity < item.quantity && <small className="reservation-warning">{ui("storefront.some_items_need_availability_checked_review_your_cart", "Some items need availability checked. Review your cart.")}</small>}
      </article>)}
    </section>
    {!!cart?.items.length && <div className="store-cart-drawer-footer"><div className="drawer-subtotal"><span>{ui("storefront.subtotal_after_discounts", "Subtotal after discounts")}</span><strong>{subtractMoney(cart.subtotal, cart.discount_amount)} {cart.currency}</strong></div><p>{ui("storefront.delivery_and_tax_are_calculated_at_checkout", "Delivery and tax are calculated at checkout.")}</p>
      <span role="status" className="drawer-save-status">{syncing ? ui("storefront.updating_your_cart", "Updating your cart…") : ''}</span>
      {!syncing && !error && !Object.keys(quantityErrors).length && cart.fully_reserved ? <Link className="primary-link" to="/checkout">{ui("storefront.continue_to_checkout", "Continue to checkout")}</Link> : <button type="button" disabled>{ui("storefront.continue_to_checkout", "Continue to checkout")}</button>}
      <Link className="drawer-view-cart" to="/cart">{ui("storefront.view_full_cart", "View full cart")}</Link>
    </div>}
  </dialog>;
}
function DrawerProductImage({ id, name }: { id: string; name: string }) {
  const {t:ui,locale}=useInterface();
  const product = useQuery({ queryKey: ['cart-product', id, locale], queryFn: () => catalogApi.product(id, locale), staleTime: 60000 });
  return <Link className="drawer-product-image" to={`/products/${id}`} aria-label={ui("cart.view_product", "View {name}", {name})}>{product.data?.media_ids[0] ? <img src={mediaUrl(product.data.media_ids[0])} alt="" /> : <span aria-hidden="true">◇</span>}</Link>;
}

export function AddToCart({ id, compact = false, productName, purchasePanel = false }: { id: string; compact?: boolean; productName?: string; purchasePanel?: boolean }) {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const theme = useTheme();
  const grocery = !theme.global.top.some(section => section.enabled && section.component === 'presentation' && ['heritage', 'showcase', 'editorial'].includes(String(section.settings.style)));
  const delivery=useDeliveryKey();
  const status=useDeliveryStatus();
  const assistantDelivery = useAssistantDelivery();
  const { cart, setCart, ready, error, quantities, quantityErrors, changeQuantity } = useContext(Context);
  const [quantity, setQuantity] = useState(1);
  const submitting = useRef(false);
  const a = useAction();
  const stock = useQuery({
    queryKey: ["stock", id,delivery],
    queryFn: () => inventoryApi.stock(id),
    refetchInterval: 3000,
  });
  const available = stock.data?.available ?? 0;
  const validQuantity = Number.isInteger(quantity) && quantity >= 1 && quantity <= available;
  const blocked = !ready || !!error || !!stock.error || stock.isPending || a.busy;
  const item = cart?.items.find(item => item.product_id === id);
  const pending = quantities[id];
  const inCart = pending?.quantity ?? item?.quantity ?? 0;
  const limit = pending?.limit ?? Math.min(available + (item?.reserved_quantity ?? 0), item?.available ?? Infinity);
  const canIncrease = !blocked && limit > inCart;
  function changeCart(delta: number) {
    if (!ready || error || (delta > 0 && !canIncrease)) return;
    changeQuantity(id, delta, limit);
  }
  if (assistantDelivery && delivery === "none" && status.data?.configured) return (
    <button type="button" className="assistant-delivery-required" onClick={assistantDelivery.requestLocation}>
      {ui("storefront.choose_delivery_address", "Choose delivery address")} <span className="direction-icon" aria-hidden="true">→</span>
    </button>
  );
  if (grocery) return <div className="add-to-cart grocery-add-to-cart" data-syncing={!!pending}>
    <div className="grocery-cart-control">
      {purchasePanel && <span className="purchase-quantity-label">{ui("storefront.quantity_in_your_cart", "Quantity in your cart")}</span>}
      <div className="grocery-quantity" role="group" aria-label={productName ? ui("cart.cart_quantity_for", "Cart quantity for {name}", {name:productName}) : ui("cart.cart_quantity", "Cart quantity")}>
        <button type="button" aria-label={inCart === 1 ? ui("cart.remove_product", "Remove from cart") : ui("cart.decrease_quantity", "Decrease quantity")} title={inCart === 1 ? ui("cart.remove_product", "Remove from cart") : ui("cart.decrease_quantity", "Decrease quantity")} disabled={inCart === 0 || !ready || !!error} onClick={() => changeCart(-1)}>−</button>
        <output aria-label={ui("storefront.quantity_in_cart", "Quantity in cart")}>{inCart}</output>
        <button type="button" aria-label={inCart === 0 ? (productName ? ui("cart.add_product", "Add {name} to cart", {name:productName}) : ui("cart.add", "Add to cart")) : ui("storefront.increase_quantity", "Increase quantity")} title={ui("storefront.increase_quantity", "Increase quantity")} disabled={!canIncrease} onClick={() => changeCart(1)}>+</button>
      </div>
    </div>
    <span className="sr-only" role="status">{pending ? ui("cart.in_cart_saving", "{count} in cart. Saving\u2026", {count:inCart}) : ui("cart.in_cart", "{count} in cart", {count:inCart})}</span>
    {!compact && !stock.isPending && !stock.error && available === 0 && inCart === 0 && <p className="stock-note sold-out">{status.data?.configured ? ui("storefront.unavailable_in_your_area", "Unavailable in your area") : ui("product.out_of_stock", "Out of stock")}</p>}
    <Notice error>{message((quantityErrors[id] || stock.error?.message || error?.message) || '')}</Notice>
  </div>;
  return (
    <div className="add-to-cart">
      {!compact && <p className={available > 0 ? "stock-note" : "stock-note sold-out"}>
        {stock.isPending
          ? ui("storefront.checking_availability", "Checking availability…")
          : available === 0
            ? (status.data?.configured?ui("storefront.unavailable_in_your_area", "Unavailable in your area"):ui("product.out_of_stock", "Out of stock"))
            : available <= 5
              ? ui("cart.low_stock", "Low stock \u2014 only {count} available", {count:available})
              : ui("cart.available_units", "{count} units available", {count:available})}
      </p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (submitting.current || blocked || !validQuantity) return;
          submitting.current = true;
          void a.run(async () => {
            try {
              const cart = await cartApi.add(id, quantity);
              track("cart_added", "/cart");
              setCart(cart);
              a.setMessage("Added to your cart. Stock is reserved for a limited time.");
            } finally { submitting.current = false; }
          });
        }}
      >
        <label className="field quantity">
          {ui("product.quantity", "Quantity")} <input
            type="number"
            aria-label={productName ? ui("cart.quantity_for", "Quantity for {name}", {name:productName}) : undefined}
            min="1"
            max={Math.max(available, 1)}
            required
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>
        <button className="add-cart-submit" aria-label={productName && available > 0 ? ui("cart.add_product", "Add {name} to cart", {name:productName}) : undefined} disabled={blocked || !validQuantity}>
          {a.busy ? ui("storefront.adding", "Adding…") : available < 1 ? (status.data?.configured?ui("storefront.unavailable_in_your_area", "Unavailable in your area"):ui("product.out_of_stock", "Out of stock")) : ui("cart.add", "Add to cart")}
        </button>
      </form>
      <Notice error>{message((a.error || stock.error?.message || error?.message) || '')}</Notice>
      <Notice>{message((a.message) || '')}</Notice>
      {a.message && (
        <Link className="text-button" to="/cart">
          {ui("storefront.view_your_cart", "View your cart")} <span className="direction-icon" aria-hidden="true">→</span>
        </Link>
      )}
      {!compact && <p className="help">
        {ui("cart.reservation_help", "Your items are held temporarily while you browse. You can build a cart without signing in.")} </p>}
    </div>
  );
}
function Line({ item }: { item: CartItem }) {
  const { message } = useInterface();
  const { t: ui, locale } = useInterface();
  const { setCart, syncing } = useContext(Context);
  const product = useQuery({ queryKey: ["cart-product", item.product_id, locale], queryFn: () => catalogApi.product(item.product_id, locale) });
  const name = product.data?.name ?? item.name;
  const a = useAction();
  const expired = item.reserved_quantity < item.quantity;
  return (
    <article className="cart-line">
      <Link className="cart-product-image" to={`/products/${item.product_id}`} aria-label={ui("cart.view_product", "View {name}", {name})}>
        {product.data?.media_ids[0] ? <img src={mediaUrl(product.data.media_ids[0])} alt={name} /> : <span>{ui("storefront.image_unavailable", "Image unavailable")}</span>}
      </Link>
      <div>
        <Link to={`/products/${item.product_id}`}>
          <h2>{name}</h2>
        </Link>
        <p>
          {item.price} {item.currency} / {item.unit}
        </p>
        <p className={expired ? "reservation-warning" : "reservation-note"}>
          {expired
            ? ui("cart.partial_reservation", "{reserved} of {quantity} reserved. Update quantity to reserve available stock.", {reserved:item.reserved_quantity,quantity:item.quantity})
            : !item.expires_at || !Number.isFinite(Date.parse(item.expires_at)) ? ui("cart.reservation_pending", "Reservation pending") : ui("cart.reserved_until", "Reserved until {time}", {time:new Date(item.expires_at!).toLocaleTimeString(locale === "ar" ? "ar" : undefined, {hour:"2-digit",minute:"2-digit"})})}
        </p>
        {expired && (
          <p className="help">
            {ui("cart.available_for_cart", "Only {count} units available for this cart.", {count:item.available})} </p>
        )}
      </div>
      <form
        key={item.quantity}
        className="cart-quantity"
        onSubmit={(e) => {
          e.preventDefault();
          if (syncing) return;
          const quantity = Number(
            new FormData(e.currentTarget).get("quantity"),
          );
          void a.run(async () =>
            setCart(await cartApi.update(item.product_id, quantity)),
          );
        }}
      >
        <label className="field">
          {ui("product.quantity", "Quantity")} <input
            name="quantity"
            type="number"
            min="1"
            max="1000000"
            required
            defaultValue={item.quantity}
          />
        </label>
        <button className="secondary" disabled={a.busy || syncing}>
          {expired ? ui("storefront.reserve_again", "Reserve again") : ui("storefront.update", "Update")}
        </button>
      </form>
      <div className="cart-line-total">
        <strong>{item.line_total} {item.currency}</strong>
        <button
          className="cart-remove icon-button"
          aria-label={ui("common.remove", "Remove")}
          title={`${ui("common.remove", "Remove")}: ${item.name}`}
          disabled={a.busy || syncing}
          onClick={() =>
            a.run(async () => setCart(await cartApi.remove(item.product_id)))
          }
        >
          <CartCloseIcon /></button>
      </div>
      <Notice error>{message((a.error) || '')}</Notice>
    </article>
  );
}
export function DiscountLines({ items = [], currency = "currency unavailable" }: { items?: AppliedDiscount[]; currency?: string }) {
  return (
    <>
      {items.map((d) => (
        <p className="order-line" key={d.rule_id}>
          <span>
            {d.name}
            {d.coupon_code ? ` (${d.coupon_code})` : ""}
          </span>
          <strong>−{d.amount} {currency}</strong>
        </p>
      ))}
    </>
  );
}
export function CouponEntry({
  onChange,
  disabled = false,
  onPendingChange,
}: {
  onChange?: () => void;
  disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const { cart, setCart, syncing } = useContext(Context),
    a = useAction();
  const [code, setCode] = useState("");
  async function apply(value: string) {
    onPendingChange?.(true);
    try {
      setCart(await cartApi.coupon(value));
      setCode("");
      onChange?.();
      a.setMessage(value ? "Coupon applied." : "Coupon removed.");
    } finally { onPendingChange?.(false); }
  }
  return (
    <section className="coupon-entry" aria-label={ui("storefront.coupon", "Coupon")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled || syncing || a.busy) return;
          void a.run(() => apply(code));
        }}
      >
        <label className="field">
          {ui("storefront.coupon_code", "Coupon code")} <input
            value={code}
            maxLength={40}
            required
            disabled={disabled || syncing || a.busy}
            onChange={(e) => setCode(e.target.value)}
            placeholder={ui("storefront.enter_a_code", "Enter a code")}
          />
        </label>
        <button className="secondary" disabled={!cart || disabled || syncing || a.busy}>
          {ui("storefront.apply_coupon", "Apply coupon")} </button>
      </form>
      {cart?.coupon_code && (
        <p>
          {ui("storefront.selected", "Selected:")} <strong>{cart.coupon_code}</strong>{" "}
          <button
            className="text-button"
            disabled={disabled || syncing || a.busy}
            onClick={() => a.run(() => apply(""))}
          >
            {ui("storefront.remove_coupon", "Remove coupon")} </button>
        </p>
      )}
      <Notice error>{message((a.error || cart?.coupon_error) || '')}</Notice>
      <Notice>{message((a.message) || '')}</Notice>
    </section>
  );
}
export function CartPage() {
  const { message } = useInterface();
  const { t: ui } = useInterface();
  const { cart, error, syncing, quantities, quantityErrors } = useContext(Context);
  return (
    <main className="cart-main">
      <nav className="breadcrumbs">
        <Link to="/">{ui("navigation.home", "Home")}</Link>
        <span>/ {ui("cart.title", "Your cart")}</span>
      </nav>
      <header className="cart-page-heading"><h1>{ui("storefront.shopping_cart", "Shopping cart")}</h1>{cart && <span>{ui("cart.item_count", "{count} items", {count:cartQuantityCount(cart, quantities)})}</span>}</header>
      <Notice error>{message((error?.message) || '')}</Notice>
      <Notice error>{message((Object.values(quantityErrors).join(' ')) || '')}</Notice>
      {syncing && <p role="status">{ui("storefront.saving_your_latest_quantities", "Saving your latest quantities…")}</p>}
      {!cart && !error && <p role="status">{ui("storefront.opening_your_cart", "Opening your cart…")}</p>}
      {cart &&
        (!cart.items.length ? (syncing ? null : (
          <section className="empty-cart">
            <h2>{ui("storefront.your_shopping_cart_is_empty", "Your shopping cart is empty")}</h2>
            <p>{ui("storefront.find_something_you_love_and_add_it_to_your_cart", "Find something you love and add it to your cart.")}</p>
            <Link className="primary-link" to="/search">
              {ui("storefront.start_shopping", "Start shopping")} </Link>
          </section>
        )) : (
          <div className="cart-layout">
            <section aria-label={ui("storefront.cart_items", "Cart items")}>
              {!cart.fully_reserved && (
                <Notice error>
                  {ui("cart.merged_reservations", "Some reservations expired or could not be restored when carts were merged. Your items are saved; update their quantities to reserve stock again.")} </Notice>
              )}
              {cart.items.map((item) => (
                <Line key={item.product_id} item={item} />
              ))}
            </section>
            <aside className="cart-summary">
              <h2>{ui("checkout.order_summary", "Order summary")}</h2>
              <div>
                <span>{ui("cart.subtotal", "Subtotal")}</span>
                <strong>{cart.subtotal} {cart.currency}</strong>
              </div>
              <DiscountLines items={cart.discount_snapshot} currency={cart.currency} />
              <div className="cart-payable">
                <span>{ui("storefront.total_before_delivery_and_tax", "Total before delivery & tax")}</span>
                <strong>
                  {subtractMoney(cart.subtotal,cart.discount_amount)} {cart.currency}
                </strong>
              </div>
              <p className="help">
                {ui("storefront.delivery_and_tax_are_calculated_at_checkout_offers_are_rechecked_before_ordering", "Delivery and tax are calculated at checkout. Offers are rechecked before ordering.")} </p>
              <CouponEntry />
              {cart.customer_id ? (
                <>
                  <Link className="primary-link" to="/checkout">
                    {ui("checkout.title", "Checkout")} </Link>
                  <p className="help">
                    {ui("cart.account_saved", "Your cart is saved to your account. Reservations still expire at the times shown.")} </p>
                </>
              ) : (
                <>
                  <Link className="primary-link" to="/checkout">
                    {ui("storefront.sign_in_to_continue", "Sign in to continue")} </Link>
                  <p className="help">
                    {ui("storefront.sign_in_or_register_to_choose_delivery_and_place_your_order", "Sign in or register to choose delivery and place your order.")} </p>
                </>
              )}
              <Link className="text-button" to="/search">
                <span className="direction-icon" aria-hidden="true">←</span>  {ui("storefront.continue_browsing", "Continue browsing")} </Link>
            </aside>
          </div>
        ))}
      {!!cart?.items.length && <ProductRelationships sources={cart.items.map(item=>item.product_id)} kind="cross_sell" customerId={cart.customer_id??undefined}/>}
    </main>
  );
}

function CartProductName({ id, fallback }: { id: string; fallback: string }) {
  const { locale } = useInterface();
  const product = useQuery({ queryKey: ["cart-product", id, locale], queryFn: () => catalogApi.product(id, locale), staleTime: 60000 });
  return <>{product.data?.name ?? fallback}</>;
}
