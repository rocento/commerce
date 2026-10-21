import { useInterface } from './interface-locale';
import { checkoutReply, type RegisterCheckoutReply } from "./checkout-replies";
import { CheckoutFieldsLoading } from "./checkout-loading";
import { subtractMoney } from './market-money';
import { FulfillmentOptions } from "./fulfillment-options";
import { fulfillmentPlanApi, type FulfillmentPlan } from "@commerce/api-client";
import { DeliverySlots } from "./delivery-slots";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { customerApi, orderApi, locationAddress, setDeliveryPin, mediaUrl, type Customer, type CheckoutQuote, type LocationInput } from '@commerce/api-client';
import { BrandLogo, Notice, useAction } from '@commerce/ui';
import { useCart, CouponEntry } from './cart';
import { DeliveryFields, SavedAddressList, emptyDelivery, useActiveLocation, useDeliveryKey } from './locations';
import { selectDeliveryLocation } from './locations-logic';
import { OrderItemImage } from './orders';
import { useTheme, themeOptions } from './themes';
import { track } from './analytics';
import { cartFingerprint, checkoutMoney as money, definitiveCheckoutRejection, quoteExpired, readCheckoutAttempt, type CheckoutAttempt } from './checkout-logic';
import './checkout.css';

const EmbeddedCheckout = createContext(false);

function LockIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg>;
}
function CheckoutBrand() {
  const { t: ui } = useInterface();
  const theme = useTheme();
  const options = themeOptions(theme, 'header_options', 'top');
  const configuredBrand = String(theme.global.top.find(section => section.enabled && section.component === 'header')?.settings.brand || 'Rocento');
  const brand = configuredBrand === 'Commerce' ? 'Rocento' : configuredBrand;
  return <div className="checkout-brand-row"><Link to="/" className="checkout-brand" aria-label={ui("checkout.brand_home", "{brand} home", {brand})}>
    {options.image ? <img src={mediaUrl(String(options.image))} alt={String(options.alt || brand)} /> : brand === 'Rocento' ? <BrandLogo /> : <span>{brand}</span>}
  </Link><Link className="checkout-cart-link" to="/cart" aria-label={ui("storefront.return_to_cart", "Return to cart")}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 7h14l1 14H4L5 7Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg></Link></div>;
}
function CheckoutSummary({ quote, locked = false, onCouponChange, couponBusy, onCouponPending }: { quote?: CheckoutQuote | null; locked?: boolean; onCouponChange?: () => void; couponBusy?: boolean; onCouponPending?: (pending: boolean) => void }) {
  const { t: ui } = useInterface();
  const { cart, ready, error } = useCart();
  const embedded = useContext(EmbeddedCheckout);
  const [open, setOpen] = useState(embedded);
  const snapshot = quote?.snapshot;
  const items = snapshot?.items ?? cart?.items ?? [];
  const currency = snapshot?.currency ?? cart?.currency ?? 'USD';
  const amount = snapshot?.total ?? cart?.subtotal;
  return <aside className="checkout-order-summary" aria-label={ui("checkout.order_summary", "Order summary")} data-open={open}>
    <button type="button" className="checkout-summary-toggle secondary" aria-expanded={open} aria-controls="checkout-summary-content" onClick={() => setOpen(!open)}><span>{open ? ui("storefront.hide", "Hide") : ui("storefront.show", "Show")}  {ui("storefront.order_summary", "order summary")} <span aria-hidden="true">{open ? '⌃' : '⌄'}</span></span><strong>{amount === undefined ? '—' : money(amount, currency)}{!snapshot && <small>{ui("cart.subtotal", "Subtotal")}</small>}</strong></button>
    <div id="checkout-summary-content" className="checkout-summary-content">
      <div className="checkout-summary-title"><h2>{ui("checkout.order_summary", "Order summary")}</h2>{!locked && <Link to="/cart">{ui("storefront.edit_cart", "Edit cart")}</Link>}</div>
      {!ready && !snapshot && !error ? <div className="checkout-loading-summary" role="status"><span className="sr-only">{ui("storefront.loading_your_cart", "Loading your cart…")}</span></div> : <>
        <div className="checkout-product-list">{items.map(item => <div className="checkout-product" key={item.product_id}>
          <div className="checkout-product-thumbnail"><OrderItemImage productId={item.product_id} name={item.name} /><span className="checkout-quantity" aria-label={ui("cart.quantity_value", "Quantity {count}", {count:item.quantity})}>{item.quantity}</span></div>
          <div className="checkout-product-description"><strong>{item.name}</strong><small>{item.sku} · {item.unit}</small></div><strong className="checkout-product-price">{money(subtractMoney(item.line_total, 'discount_amount' in item ? item.discount_amount : '0'), currency)}</strong>
        </div>)}</div>
        {!items.length && <p className="checkout-muted">{ui("storefront.your_cart_is_empty", "Your cart is empty.")}</p>}
        {!!items.length && <>
          {!locked && <CouponEntry disabled={couponBusy} onChange={onCouponChange} onPendingChange={onCouponPending} />}
          <dl className="checkout-costs"><div><dt>{ui("storefront.subtotal", "Subtotal ·")} {ui("cart.item_count", "{count} items", {count:items.reduce((n, item) => n + item.quantity, 0)})}</dt><dd>{money(snapshot?.subtotal ?? cart?.subtotal ?? '0', currency)}</dd></div>
            {(snapshot?.discount_snapshot ?? cart?.discount_snapshot ?? []).map(discount => <div className="checkout-discount" key={discount.rule_id}><dt>{discount.name}{discount.coupon_code && ` (${discount.coupon_code})`}</dt><dd>−{money(discount.amount, currency)}</dd></div>)}
            <div><dt>{snapshot?.fulfillment_plan?.method === 'pickup' ? ui("checkout.pickup", "Pickup") : ui("cart.delivery", "Delivery")}</dt><dd>{snapshot ? Number(snapshot.delivery_fee) === 0 ? ui("storefront.free", "Free") : money(snapshot.delivery_fee, currency) : ui("storefront.calculated_before_payment", "Calculated before payment")}</dd></div>
            <div><dt>{snapshot?.tax_snapshot?.name || ui("storefront.taxes", "Taxes")}</dt><dd>{snapshot ? money(snapshot.tax_amount, currency) : ui("storefront.calculated_before_payment", "Calculated before payment")}</dd></div>
            <div className="checkout-grand-total"><dt>{snapshot ? ui("cart.total", "Total") : ui("cart.subtotal", "Subtotal")}</dt><dd><small>{currency}</small>{money(amount ?? '0', currency)}</dd></div>
          </dl>
          <p className="checkout-summary-note">{snapshot ? snapshot.fulfillment_plan?.method === 'pickup' ? ui("checkout.cash_pickup_note", "Cash at pickup. No payment is collected online.") : ui("checkout.cash_delivery_note", "Cash on delivery. No payment is collected online.") : ui("storefront.shipping_discounts_and_taxes_are_confirmed_before_you_place_your_order", "Shipping, discounts and taxes are confirmed before you place your order.")}</p>
        </>}
      </>}
      {error && !snapshot && <Notice error>{ui("storefront.we_couldn_t_load_your_cart_refresh_the_page_to_try_again", "We couldn’t load your cart. Refresh the page to try again.")}</Notice>}
      <div className="checkout-summary-support"><LockIcon/><span>{ui("storefront.your_order_is_only_submitted_when_you_confirm_it", "Your order is only submitted when you confirm it.")}</span></div>
    </div>
  </aside>;
}
function CheckoutLayout({ children, quote, locked, onCouponChange, couponBusy, onCouponPending }: { children: ReactNode; quote?: CheckoutQuote | null; locked?: boolean; onCouponChange?: () => void; couponBusy?: boolean; onCouponPending?: (pending: boolean) => void }) {
  const { t: ui } = useInterface();
  const embedded = useContext(EmbeddedCheckout);
  if (embedded) return <section className="checkout-flow assistant-checkout-conversation" aria-label={ui("storefront.checkout_conversation", "Checkout conversation")}>{children}</section>;
  return <main className="checkout-flow"><div className="checkout-layout">
    <CheckoutSummary quote={quote} locked={locked} onCouponChange={onCouponChange} couponBusy={couponBusy} onCouponPending={onCouponPending}/>
    <div className="checkout-information"><CheckoutBrand/><div className="checkout-heading"><h1>{ui("checkout.title", "Checkout")}</h1><span><LockIcon/>{ui("checkout.secure", "Secure checkout")}</span></div>{children}
      <div className="checkout-help-links"><Link to="/cart"><span className="direction-icon" aria-hidden="true">←</span>  {ui("storefront.return_to_cart", "Return to cart")}</Link><Link to="/support">{ui("storefront.need_help", "Need help?")}</Link></div>
    </div>
  </div></main>;
}
function CheckoutMessage({ children, customer = false, label }: { children: ReactNode; customer?: boolean; label: string }) {
  const { t: ui } = useInterface();
  return <article className={`checkout-chat-message${customer ? ' checkout-chat-customer' : ''}`} aria-label={label}>
    <strong className="checkout-chat-speaker">{customer ? ui("storefront.you", "You") : ui("storefront.rocento_assistant", "Rocento assistant")}</strong>
    <div>{children}</div>
  </article>;
}
export function Checkout({ customer, embedded = false, onReplyReady, onViewOrder }: { customer: Customer | null; embedded?: boolean; onReplyReady?: RegisterCheckoutReply; onViewOrder?: (orderId: string) => void }) {
  return <EmbeddedCheckout.Provider value={embedded}><CheckoutContent customer={customer} onReplyReady={embedded ? onReplyReady : undefined} onViewOrder={onViewOrder}/></EmbeddedCheckout.Provider>;
}
function CheckoutContent({ customer, onReplyReady, onViewOrder }: { customer: Customer | null; onReplyReady?: RegisterCheckoutReply; onViewOrder?: (orderId: string) => void }) {
  const { t: ui } = useInterface();
  if (!customer) return <CheckoutLayout locked><section className="checkout-section checkout-account-gate"><h2>{ui("storefront.contact", "Contact")}</h2><p>{ui("storefront.sign_in_to_complete_your_order", "Sign in to complete your order")}</p><p className="checkout-muted">{ui("storefront.your_cart_stays_with_you_sign_in_or_create_an_account_to_save_your_address_and_track_your_delivery", "Your cart stays with you. Sign in or create an account to save your address and track your delivery.")}</p><Link className="checkout-primary" to="/login?next=checkout">{ui("storefront.sign_in_to_checkout", "Sign in to checkout")}</Link><Link className="checkout-secondary-link" to="/register?next=checkout">{ui("storefront.create_an_account", "Create an account")}</Link></section></CheckoutLayout>;
  return <CheckoutAccount key={customer.id} customer={customer} onReplyReady={onReplyReady} onViewOrder={onViewOrder}/>;
}
function CheckoutAccount({ customer, onReplyReady, onViewOrder }: { customer: Customer; onReplyReady?: RegisterCheckoutReply; onViewOrder?: (orderId: string) => void }) {
  const { message } = useInterface();
  const { t: ui, preview: interfacePreview, locale } = useInterface();
  const embedded = useContext(EmbeddedCheckout);
  const cache = useQueryClient();
  const { cart, ready, error: cartError, syncing } = useCart();
  const profile = useQuery({ queryKey: ['profile'], queryFn: customerApi.me });
  const current = profile.data ?? customer;
  const storageKey = `checkout-attempt:${customer.id}`;
  const [restored] = useState(() => { try { return { attempt: readCheckoutAttempt(sessionStorage, storageKey), error: '' }; } catch (error) { return { attempt: null, error: error instanceof Error ? error.message : 'Your saved checkout is unavailable. Please check your orders before continuing.' }; } });
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(restored.attempt);
  const [step, setStep] = useState<'delivery' | 'payment' | 'review'>(restored.attempt ? 'review' : 'delivery');
  const paymentStep = !embedded || !!attempt || step !== 'delivery';
  const reviewStep = !embedded || !!attempt || step === 'review';
  const [deliveryReceipt, setDeliveryReceipt] = useState('');
  const [paymentReceipt, setPaymentReceipt] = useState('');
  const [replyNotice, setReplyNotice] = useState('');
  const stepHeading = useRef<HTMLHeadingElement>(null);
  function changeStep(next: 'delivery' | 'payment') {
    setStep(next); setConsentedQuote(''); setPaymentReceipt(''); setReplyNotice('');
    if (next === 'payment' && quote) setDeliveryReceipt(locationAddress(quote.snapshot.location));
    if (next === 'delivery') setDeliveryReceipt('');
    requestAnimationFrame(() => stepHeading.current?.focus());
  }
  function confirmPayment() {
    if (!canContinue || !quote || quoteExpired(quote)) return;
    setConsentedQuote(quote.id);
    setPaymentReceipt(`Cash ${pickup ? 'at pickup' : 'on delivery'} · ${total}`);
    setStep('review'); setReplyNotice('');
    requestAnimationFrame(() => stepHeading.current?.focus());
  }
  const fulfillment=useQuery({queryKey:['fulfillment-availability',customer.id],queryFn:fulfillmentPlanApi.availability,enabled:current.verified&&ready,retry:false});
  const [methodChoice,setMethodChoice]=useState<'delivery'|'pickup'>('delivery');
  const method=attempt ? (attempt.quote.snapshot.fulfillment_plan?.method==='pickup'?'pickup':'delivery') : fulfillment.data?.methods.some(m=>m.type===methodChoice)?methodChoice:(fulfillment.data?.methods[0]?.type??'delivery');
  const pickup=method==='pickup';
  const [plan,setPlan]=useState<FulfillmentPlan|null>(null);
  const locations = useQuery({ queryKey: ['locations'], queryFn: customerApi.locations, enabled: current.verified && !pickup });
  const [active, setActive] = useActiveLocation(customer.id);
  const selected = selectDeliveryLocation(locations.data, active);
  const initialAddress = useRef(active);
  const initialAddressReviewed = useRef(false);
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);
  const [completedOrderId, setCompletedOrderId] = useState("");
  const [couponPending, setCouponPending] = useState(false);
  const submitting = useRef(false), completed = useRef(false);
  const [gift, setGift] = useState(restored.attempt?.quote.snapshot.gift_message ?? '');
  const [debouncedGift, setDebouncedGift] = useState(gift);
  const [revision, setRevision] = useState(0);
  const [consentedQuote, setConsentedQuote] = useState('');
  const [showLocation, setShowLocation] = useState(false);
  const [confirmedAddress, setConfirmedAddress] = useState('');
  const addressKey = selected ? `${selected.id}:${selected.updated_at}` : '';
  useEffect(() => {
    if (initialAddressReviewed.current || !locations.isSuccess) return;
    initialAddressReviewed.current = true;
    const saved = locations.data.find(address => address.id === initialAddress.current);
    if (embedded && !pickup && !attempt && saved && active === saved.id) {
      setConfirmedAddress(`${saved.id}:${saved.updated_at}`);
    }
  }, [locations.isSuccess, locations.data, embedded, pickup, attempt, active]);
  const choosingAddress = embedded && !pickup && !attempt && (!addressKey || confirmedAddress !== addressKey || showLocation);
  function confirmAddress() {
    if (!selected || busy || syncing || addressAction.busy) return;
    setConfirmedAddress(addressKey);
    requestAnimationFrame(() => stepHeading.current?.focus());
  }
  const [editingLocation, setEditingLocation] = useState<string>();
  const [form, setForm] = useState<LocationInput>({ ...emptyDelivery });
  const addressAction = useAction();
  const [now, setNow] = useState(Date.now);
  const alertRef = useRef<HTMLDivElement>(null);
  const delivery = useDeliveryKey();
  const signature = cartFingerprint(cart);
  const planSignature=JSON.stringify(cart?.items.map(i=>[i.product_id,i.quantity,i.price]));
  useEffect(()=>{setPlan(null);},[planSignature,selected?.id,selected?.updated_at,method]);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { const id = window.setTimeout(() => setDebouncedGift(gift), 400); return () => clearTimeout(id); }, [gift]);
  useLayoutEffect(() => { if (submitError) alertRef.current?.focus({preventScroll:true}); }, [submitError]);
  const latitude = selected?.latitude, longitude = selected?.longitude;
  useEffect(() => {
    if (attempt || latitude === undefined || longitude === undefined || syncing || pickup) return;
    setDeliveryPin({ latitude, longitude });
  }, [latitude, longitude, attempt, syncing, pickup]);
  const giftTooLong = new TextEncoder().encode(gift).length > 500;
  const contextMatches = !!selected && delivery === `${selected.latitude},${selected.longitude}`;
  const legacyFulfillment=(fulfillment.error as {status?:number}|null)?.status===404;
  // An address/method change renders before the effect above clears the old plan.
  // Never quote the new destination against that previous reservation.
  const planMatchesSelection = plan?.method === method && (pickup || plan.location_id === selected?.id);
  const planFresh=plan && planMatchesSelection && Date.parse(plan.expires_at)>now;
  const canQuote = current.verified && (fulfillment.data ? !!planFresh : legacyFulfillment && !!selected && contextMatches) && ready && !syncing && !!cart?.items.length && !!cart.fully_reserved && !cartError && (pickup || !locations.error) && !profile.error && (pickup || !showLocation) && !couponPending && !attempt && !restored.error && !giftTooLong;
  const quoteQuery = useQuery({ queryKey: ['checkout-quote', customer.id, selected?.id, selected?.updated_at, signature, debouncedGift, revision, plan?.id, pickup], queryFn: () => orderApi.quote(pickup ? null : selected!.id, debouncedGift), enabled: !!canQuote, retry: false, staleTime: Infinity, refetchOnWindowFocus: false });
  const quote = attempt?.quote ?? quoteQuery.data;
  const expired = quoteExpired(quote, now);
  const updating = !attempt && (quoteQuery.isFetching || gift !== debouncedGift || !canQuote);
  const currency = quote?.snapshot.currency ?? cart?.currency ?? 'USD';
  const total = quote ? money(quote.snapshot.total, currency) : '';
  const canContinue = !choosingAddress && !busy && !restored.error && !!quote && !expired && !updating && !quoteQuery.error;
  const canPlace = reviewStep && !busy && !restored.error && (!!attempt || (!!quote && !expired && !updating && !quoteQuery.error && consentedQuote === quote.id));
  const quoteId = quoteQuery.data?.id;
  const trackedQuote = useRef<string>();
  useEffect(() => {
    if (!quoteId || attempt || trackedQuote.current === quoteId) return;
    trackedQuote.current = quoteId;
    track('checkout_started', '/checkout');
  }, [quoteId, attempt]);
  // Replies operate only on this mounted form's current quote and saved addresses.
  // They cannot submit an order; the existing explicit Place order control owns that.
  useEffect(() => {
    if (!onReplyReady) return;
    const handleReply = (message: string) => {
      const reply = checkoutReply(message);
      if (!reply) return null;
      if (completedOrderId) return 'Your order is already confirmed. Use View order below to see its details.';
      if (!current.verified) return 'Please verify your contact details before continuing checkout.';
      if (attempt || restored.error) return 'Review the saved submission below. Use its confirmation controls to avoid a duplicate order.';
      if (busy || syncing || addressAction.busy) return 'Please wait for the current checkout update to finish.';
      if (!ready || cartError || profile.error) return 'Your checkout details are not ready. Please use the loading or retry controls below.';
      if (!cart?.items.length) return 'Your cart is empty. Choose products before continuing checkout.';
      if (reply === 'back') { changeStep('delivery'); return 'Review your delivery address and delivery options below.'; }
      if (['home', 'work', 'office'].includes(reply)) {
        if (pickup) return 'Pickup is selected. Choose Delivery below before selecting a delivery address.';
        if (locations.isPending || locations.isFetching || locations.error) return 'Please wait for your saved addresses to load, or retry below.';
        const matches = (locations.data ?? []).filter(address => [address.label, address.custom_label].some(label => label?.trim().toLowerCase() === reply));
        if (matches.length !== 1) { setConfirmedAddress(''); return matches.length ? 'More than one saved address matches. Choose the exact address below.' : 'No saved address matches that name. Choose or add an address below.'; }
        setActive(matches[0].id); setConfirmedAddress(`${matches[0].id}:${matches[0].updated_at}`); setShowLocation(false); setSubmitError(''); changeStep('delivery');
        return `Selected ${locationAddress(matches[0])}. Review the address and delivery options below, then reply “yes” to continue to payment.`;
      }
      if (reply === 'order') return paymentStep ? 'Review and confirm the payment below, then click Place order to submit this exact total. No order has been placed yet.' : 'First confirm your delivery details below, then review payment before placing your order.';
      if (reply === 'cash' && ((pickup && /delivery/i.test(message)) || (!pickup && /pickup/i.test(message)))) return `Your fulfillment method is ${pickup ? 'pickup' : 'delivery'}. Review it below before confirming payment.`;
      if (paymentStep && reply === 'delivery') return 'Delivery has been reviewed. Confirm cash payment below, then use Place order for the final confirmation.';
      if (!paymentStep) {
        if (reply === 'cash') return 'Cash payment is available. First review your delivery address and options, then reply “yes” to continue to payment.';
        if (!canContinue || quoteExpired(quote)) return 'Confirm your delivery options and wait for a current total below before continuing to payment.';
        changeStep('payment');
        return `Delivery details reviewed. Your total is ${total}. Reply “cash” to confirm cash ${pickup ? 'at pickup' : 'on delivery'}, or choose the payment option below.`;
      }
      if (!canContinue || quoteExpired(quote) || !quote) return 'The current total is not ready or has expired. Review the checkout details and refresh the total below before confirming payment.';
      // Consent is for this exact quote. New totals require a fresh confirmation.
      confirmPayment();
      return `Cash ${pickup ? 'at pickup' : 'on delivery'} confirmed for ${total}. Review the summary, then click Place order below to submit. No order has been placed yet.`;
    };
    onReplyReady(message => { const response = handleReply(message); if (response) setReplyNotice(response); return response; });
    return () => onReplyReady(null);
  });
  async function placeOrder() {
    if (interfacePreview || submitting.current || completed.current || !canPlace || !quote) return;
    submitting.current = true; setBusy(true); setSubmitError('');
    let next = attempt;
    try {
      if (!next) {
        if (quoteExpired(quote)) throw new Error('Your total has expired. Refresh it and confirm the updated amount.');
        next = { quote, key: crypto.randomUUID() };
        try { sessionStorage.setItem(storageKey, JSON.stringify(next)); }
        catch { throw new Error('Allow browser session storage to submit your order safely, then try again. No order was sent.'); }
        setAttempt(next);
      }
      const result = await orderApi.place(next.quote.id, next.key);
      completed.current = true;
      try { sessionStorage.removeItem(storageKey); } catch { /* The saved key still resolves to the same order. */ }
      track('order_placed', '/checkout/complete', undefined, undefined, result.order.id);
      void Promise.allSettled([cache.invalidateQueries({ queryKey: ['cart'] }), cache.invalidateQueries({ queryKey: ['orders'] })]);
      setCompletedOrderId(result.order.id);
    } catch (error) {
      if (definitiveCheckoutRejection(error)) {
        try { sessionStorage.removeItem(storageKey); setAttempt(null); setRevision(value => value + 1); setConsentedQuote(''); }
        catch { /* Keep the original attempt if it cannot be cleared safely. */ }
      }
      setSubmitError(error instanceof Error ? error.message : 'We couldn’t confirm your order. Please retry.');
    } finally { submitting.current = false; setBusy(false); }
  }
  if (completedOrderId && embedded) return <CheckoutLayout locked quote={quote}>
    <CheckoutMessage label={ui("storefront.delivery_question", "Delivery question")}><h2>{ui("storefront.how_would_you_like_to_receive_your_order", "How would you like to receive your order?")}</h2></CheckoutMessage>
    <CheckoutMessage label={ui("storefront.confirmed_delivery", "Confirmed delivery")} customer><p>{deliveryReceipt || (quote && locationAddress(quote.snapshot.location))}</p></CheckoutMessage>
    <CheckoutMessage label={ui("storefront.payment_question", "Payment question")}><h2>{ui("storefront.how_would_you_like_to_pay", "How would you like to pay?")}</h2></CheckoutMessage>
    <CheckoutMessage label={ui("storefront.confirmed_payment", "Confirmed payment")} customer><p>{paymentReceipt || ui("storefront.cash_payment_confirmed", "Cash payment confirmed.")}</p></CheckoutMessage>
    <CheckoutMessage label={ui("storefront.order_confirmation", "Order confirmation")}><h2>{ui("storefront.your_order_is_confirmed", "Your order is confirmed")}</h2><p>{ui("storefront.we_received_your_order_you_can_view_it_and_track_its_status_below", "We received your order. You can view it and track its status below.")}</p>{quote && <p>{ui("storefront.total", "Total:")} {money(quote.snapshot.total, quote.snapshot.currency)}</p>}<button type="button" className="checkout-primary" disabled={!onViewOrder} onClick={() => onViewOrder?.(completedOrderId)}>{ui("storefront.view_order", "View order")}</button></CheckoutMessage>
  </CheckoutLayout>;
  if (completedOrderId) return <CheckoutLayout locked quote={quote}>
    <section className="checkout-success-page" aria-labelledby="checkout-success-title">
      <div className="delivery-bike" aria-hidden="true"><span/><b/><i/><em/></div>
      <span className="checkout-success-kicker">{ui("storefront.order_confirmed", "Order confirmed")}</span>
      <h1 id="checkout-success-title">{ui("storefront.your_order_is_confirmed", "Your order is confirmed")}</h1>
      <p>{ui("storefront.we_received_your_order_and_saved_it_to_your_account_you_can_track_status_updates_from_your_order_pag", "We received your order and saved it to your account. You can track status updates from your order page.")}</p>
      <div className="checkout-success-actions">
        <Link className="checkout-primary" to={`/account/orders/${completedOrderId}?placed=1`} replace>{ui("storefront.view_order", "View order")}</Link>
        <Link className="checkout-secondary-link" to="/">{ui("cart.continue_shopping", "Continue shopping")}</Link>
      </div>
    </section>
  </CheckoutLayout>;
  if (!current.verified && !attempt) return <CheckoutLayout locked><section className="checkout-section checkout-account-gate"><h2>{ui("storefront.verify_your_contact_details", "Verify your contact details")}</h2><p className="checkout-muted">{ui("storefront.verify_your_email_or_mobile_number_to_finish_checking_out_your_cart_is_saved", "Verify your email or mobile number to finish checking out. Your cart is saved.")}</p><Link className="checkout-primary" to={'/verify?next=checkout&identifier=' + encodeURIComponent(current.email || current.mobile_number || '')}>{ui("storefront.verify_account", "Verify account")}</Link><Notice error>{message((profile.error?.message) || '')}</Notice></section></CheckoutLayout>;
  return <CheckoutLayout quote={quote} locked={!!attempt || !!restored.error} couponBusy={busy || showLocation} onCouponPending={setCouponPending} onCouponChange={() => { setConsentedQuote(''); setRevision(value => value + 1); }}>
    {restored.error && <div className="checkout-alert" role="alert"><strong>{ui("storefront.check_your_previous_order", "Check your previous order")}</strong><p>{message((restored.error) || "")}</p><Link to="/account/orders">{ui("storefront.view_your_orders", "View your orders")}</Link></div>}
    {attempt && <div className="checkout-recovery" role="status"><strong>{ui("storefront.confirm_your_saved_submission", "Confirm your saved submission")}</strong><p>{ui("storefront.your_last_submission_is_saved_retry_confirmation_to_receive_the_same_order_safely_even_if_the_connec", "Your last submission is saved. Retry confirmation to receive the same order safely, even if the connection was interrupted.")}</p><Link to="/account/orders">{ui("storefront.check_your_orders", "Check your orders")}</Link></div>}
    {!embedded && !!submitError && <div ref={alertRef} tabIndex={-1} role="alert" className="checkout-alert"><strong>{ui("storefront.we_couldn_t_confirm_your_order", "We couldn’t confirm your order")}</strong><p>{message((submitError) || "")}</p>{attempt && <p>{ui("storefront.keep_this_page_open_and_retry_confirmation_your_saved_submission_will_be_reused", "Keep this page open and retry confirmation. Your saved submission will be reused.")}</p>}</div>}
    {!attempt && (cartError || (!pickup && locations.error) || profile.error) && <div className="checkout-alert" role="alert"><strong>{ui("storefront.some_checkout_details_couldn_t_load", "Some checkout details couldn’t load")}</strong><p>{message((cartError?.message || locations.error?.message || profile.error?.message) || "")}</p><button type="button" className="checkout-text-button text-button" onClick={() => { void cache.invalidateQueries({ queryKey: ['cart'] }); void locations.refetch(); void profile.refetch(); }}>{ui("storefront.retry_loading_details", "Retry loading details")}</button></div>}
    {syncing && !attempt && <p role="status">{ui("storefront.saving_your_latest_quantities", "Saving your latest quantities…")}</p>}
    {!attempt && ((!ready && !cartError) || (ready && fulfillment.isPending) || (!pickup && locations.isPending)) ? <CheckoutFieldsLoading /> : ready && !syncing && !cart?.items.length && !attempt ? <section className="checkout-section checkout-account-gate"><h2>{ui("cart.empty", "Your cart is empty")}</h2><p className="checkout-muted">{ui("storefront.add_something_you_love_before_checking_out", "Add something you love before checking out.")}</p><Link className="checkout-primary" to="/search">{ui("cart.continue_shopping", "Continue shopping")}</Link></section> : <>
      {embedded && !paymentStep && pickup && <CheckoutMessage label={ui("storefront.pickup_question", "Pickup question")}><h2 ref={stepHeading} tabIndex={-1}>{ui("storefront.where_would_you_like_to_collect_your_order", "Where would you like to collect your order?")}</h2></CheckoutMessage>}
      <div hidden={embedded && paymentStep} className={embedded ? "checkout-step-panel checkout-chat-turns" : "checkout-step-panel"}>
      {!embedded && <section className="checkout-section"><div className="checkout-section-title"><h2>{ui("storefront.contact", "Contact")}</h2><span className="checkout-verified">{ui("storefront.verified", "✓ Verified")}</span></div><div className="checkout-contact-card"><strong>{attempt?.quote.snapshot.contact.email || current.email || current.mobile_number}</strong><span>{ui("storefront.order_updates_will_be_sent_to_your_account_contact", "Order updates will be sent to your account contact.")}</span></div></section>}
      {fulfillment.error&&!legacyFulfillment&&<Notice error>{message((fulfillment.error.message) || '')}</Notice>}
      {!attempt&&fulfillment.data&&fulfillment.data.methods.length>1&&<section className="checkout-section"><h2 id="checkout-receiving-heading" className={embedded ? 'sr-only' : undefined}>{ui("storefront.how_would_you_like_to_receive_your_order", "How would you like to receive your order?")}</h2><div className="checkout-receiving-options" role="radiogroup" aria-labelledby="checkout-receiving-heading">{fulfillment.data.methods.map(m=><label className="checkout-receiving-option" data-selected={method===m.type} key={m.type}><input type="radio" name="fulfillment-method" checked={method===m.type} disabled={busy} onChange={()=>{if(plan)void fulfillmentPlanApi.release(plan.id);setPlan(null);setMethodChoice(m.type);setConfirmedAddress('');setShowLocation(false);setConsentedQuote('');setSubmitError('');}}/><span><strong>{m.type==='pickup'?ui("checkout.pickup", "Pickup"):ui("cart.delivery", "Delivery")}</strong><small>{m.type==='pickup'?ui("storefront.collect_from_a_pickup_location", "Collect from a pickup location"):ui("storefront.delivered_to_your_address", "Delivered to your address")}</small></span></label>)}</div></section>}
      {!pickup && (!embedded || choosingAddress || attempt) && <section className={embedded ? "checkout-section checkout-address-message" : "checkout-section"}><div className="checkout-section-title"><div>{embedded && <strong className="checkout-chat-speaker">{ui("storefront.rocento_assistant", "Rocento assistant")}</strong>}<h2 ref={embedded && choosingAddress ? stepHeading : undefined} tabIndex={embedded ? -1 : undefined}>{embedded ? ui("storefront.where_should_we_deliver_your_order", "Where should we deliver your order?") : ui("checkout.delivery_address", "Delivery address")}</h2></div>{selected && !attempt && <button type="button" className="checkout-text-button text-button" disabled={busy || addressAction.busy} onClick={() => { setForm({ ...emptyDelivery }); setEditingLocation(undefined); setShowLocation(!showLocation); setConsentedQuote(''); }}>{showLocation ? ui("storefront.use_saved_address", "Use saved address") : ui("storefront.new_address", "+ New address")}</button>}</div>
        {attempt ? <div className="checkout-address-review"><strong>{locationAddress(attempt.quote.snapshot.location)}</strong><p>{attempt.quote.snapshot.location.delivery_instructions}</p></div> : locations.isPending ? <p role="status">{ui("storefront.loading_saved_addresses", "Loading saved addresses…")}</p> : <>
          {selected && !showLocation && <><SavedAddressList addresses={locations.data ?? []} selectedId={selected.id} onSelect={id => { setActive(id); setConsentedQuote(''); setSubmitError(''); }} disabled={busy}/><button type="button" className="checkout-text-button text-button" disabled={busy} onClick={() => { setForm({ ...selected }); setEditingLocation(selected.id); setShowLocation(true); setConsentedQuote(''); }}>{ui("storefront.edit_selected_address", "Edit selected address")}</button>{embedded && <button type="button" className="checkout-primary checkout-address-confirm" disabled={busy || syncing || addressAction.busy} onClick={confirmAddress}>{ui("storefront.use_this_address", "Use this address")}</button>}</>}
          {(!selected || showLocation) && <form className="checkout-address-form" onSubmit={event => { event.preventDefault(); void addressAction.run(async () => { const address = await customerApi.saveLocation(form, editingLocation); setActive(address.id); setConfirmedAddress(`${address.id}:${address.updated_at}`); setShowLocation(false); setEditingLocation(undefined); setPlan(null); setConsentedQuote(''); await cache.invalidateQueries({ queryKey: ['locations'] }); if (embedded) requestAnimationFrame(() => stepHeading.current?.focus()); }); }}><h3>{editingLocation ? ui("storefront.edit_delivery_address", "Edit delivery address") : ui("storefront.add_delivery_address", "Add delivery address")}</h3><DeliveryFields value={form} onChange={setForm}/><Notice error>{message((addressAction.error) || '')}</Notice><button className="checkout-address-save" disabled={addressAction.busy || busy}>{addressAction.busy ? ui("storefront.saving_address", "Saving address…") : ui("storefront.use_this_address", "Use this address")}</button></form>}

        </>}
      </section>
      }
      {!choosingAddress && <div className={embedded ? "checkout-chat-message checkout-delivery-response" : undefined} role={embedded ? "article" : undefined} aria-label={embedded ? ui("checkout.delivery_response", "Delivery options response") : undefined}>
      {embedded && <strong className="checkout-chat-speaker">{ui("storefront.rocento_assistant", "Rocento assistant")}</strong>}
      {embedded && !pickup && !choosingAddress && selected && <section className="checkout-delivery-address" aria-label={ui("storefront.selected_address", "Selected address")}>
        <div className="checkout-address-confirmation"><div><h2 className="checkout-address-summary" ref={stepHeading} tabIndex={-1}><strong>{ui("storefront.deliver_to", "Deliver to")} {selected.custom_label || (selected.label.toLowerCase() === "home" ? ui("address.home","Home") : selected.label.toLowerCase() === "work" ? ui("storefront.work","Work") : ui("storefront.other","Other"))}</strong>{' '}<span>{locationAddress(selected)}</span>{' '}<small>{[selected.building && ui("address.building_value", "Building {value}", {value:selected.building}), selected.floor && ui("address.floor_value", "Floor {value}", {value:selected.floor}), selected.apartment && ui("address.apartment_value", "Apartment {value}", {value:selected.apartment})].filter(Boolean).join(' · ')}</small></h2>{selected.delivery_instructions && <p>{selected.delivery_instructions}</p>}</div><button type="button" className="checkout-text-button text-button" disabled={busy || syncing} onClick={() => { setConfirmedAddress(''); setConsentedQuote(''); requestAnimationFrame(() => stepHeading.current?.focus()); }}>{ui("storefront.change", "Change")}</button></div>
      </section>}

          <details className="checkout-gift"><summary>{ui("storefront.add_a_gift_message", "Add a gift message")} <span>{ui("storefront.optional", "Optional")}</span></summary><label className="checkout-field"><span>{ui("storefront.gift_message", "Gift message")}</span><textarea value={gift} maxLength={500} rows={3} placeholder={ui("storefront.a_little_note_for_the_recipient", "A little note for the recipient")} onChange={event => { setGift(event.target.value); setConsentedQuote(''); }}/></label>{giftTooLong && <p role="alert" className="checkout-field-error">{ui("storefront.please_shorten_your_gift_message", "Please shorten your gift message.")}</p>}</details>
      <div className="checkout-delivery-grid">
      <div className="checkout-delivery-options">
      {fulfillment.data&&!attempt&&ready&&!!cart?.items.length&&<FulfillmentOptions key={method+String(selected?.id)+String(selected?.updated_at)+planSignature} autoReserve={embedded} expiredPlanId={plan&&!planFresh?plan.id:''} availability={fulfillment.data} method={method} locationId={selected?.id??null} locked={busy || syncing || showLocation || addressAction.busy} onInvalidated={()=>{setPlan(null);setConsentedQuote('');}} onSelected={p=>{setPlan(p);setRevision(n=>n+1);setConsentedQuote('');void cache.invalidateQueries({queryKey:['cart']});}}/>}
      {plan&&!embedded&&<p role="status">{planFresh?ui("checkout.reserved_until", "Fulfillment reserved until {time}", {time:new Date(plan.expires_at).toLocaleTimeString(locale)}):ui("storefront.your_selection_expired_please_confirm_availability_again", "Your selection expired. Please confirm availability again.")}</p>}
      {legacyFulfillment && selected && contextMatches && ready && !!cart?.items.length && <DeliverySlots key={selected.id + signature} locationId={selected.id} locked={!!attempt || busy} onSelected={() => { setRevision(n => n + 1); setConsentedQuote(''); }} />}
      </div>
      <section className="checkout-section checkout-delivery-method"><h2>{pickup ? ui("storefront.pickup_details", "Pickup details") : ui("storefront.delivery_method", "Delivery method")}</h2>{quote && !updating ? <div className="checkout-method-card"><span className="checkout-selected-dot" aria-hidden="true"/><div><strong>{pickup ? locationAddress(quote.snapshot.location) : (quote.snapshot.scheduled_delivery ? message(quote.snapshot.scheduled_delivery.method.replaceAll('_', ' ')) : '') || ui("cart.delivery", "Delivery")}</strong><span>{quote.snapshot.scheduled_delivery ? ui("checkout.scheduled_for", "Scheduled for {time}", {time:new Date(quote.snapshot.scheduled_delivery.starts_at).toLocaleString(locale, {timeZone:quote.snapshot.scheduled_delivery.timezone})}) : pickup ? ui("storefront.collect_when_your_order_is_marked_ready", "Collect when your order is marked ready") : ui("storefront.delivered_to_your_selected_address", "Delivered to your selected address")}</span></div><strong>{Number(quote.snapshot.delivery_fee) === 0 ? ui("storefront.free", "Free") : money(quote.snapshot.delivery_fee, currency)}</strong></div> : <div className="checkout-placeholder" role="status">{pickup ? ui("storefront.choose_a_pickup_location_to_check_availability", "Choose a pickup location to check availability.") : selected ? ui("storefront.confirming_shipping_and_availability", "Confirming shipping and availability…") : ui("storefront.enter_your_address_to_see_shipping_options", "Enter your address to see shipping options.")}</div>}
        {!attempt && cart?.items.length && !cart.fully_reserved ? <div className="checkout-alert" role="alert"><p>{ui("storefront.some_items_are_no_longer_fully_reserved_review_availability_in_your_cart_before_placing_your_order", "Some items are no longer fully reserved. Review availability in your cart before placing your order.")}</p><Link to="/cart">{ui("storefront.review_cart_availability", "Review cart availability")}</Link></div> : null}
        {!attempt && quoteQuery.error && <div className="checkout-alert" role="alert"><p>{quoteQuery.error.message}</p><button type="button" className="checkout-text-button text-button" disabled={!canQuote || quoteQuery.isFetching} onClick={() => void quoteQuery.refetch()}>{ui("storefront.recheck_availability_and_total", "Recheck availability and total")}</button><Link to="/cart">{ui("storefront.review_cart", "Review cart")}</Link></div>}
      </section>
      </div>
      {embedded && !attempt && expired && quote && !updating && <div className="checkout-alert" role="status"><p>{ui("storefront.your_order_total_has_expired", "Your order total has expired.")}</p><button type="button" className="checkout-text-button text-button" onClick={() => void quoteQuery.refetch()}>{ui("storefront.refresh_total", "Refresh total")}</button></div>}
      {embedded && <>{interfacePreview && <p className="interface-order-disabled" role="status">{ui("storefront.preview_order_disabled", "Order placement is disabled in this language preview.")}</p>}
        <button type="button" className="checkout-primary checkout-submit" disabled={!canContinue} onClick={() => changeStep('payment')}>{ui("checkout.continue_payment", "Continue to payment")}</button>
      <p className="checkout-confirmation-note">{ui("storefront.you_ll_review_payment_before_placing_your_order", "You’ll review payment before placing your order.")}</p></>}
      </div>}
      </div>
      {embedded && paymentStep && <CheckoutMessage label={ui("storefront.confirmed_delivery", "Confirmed delivery")} customer><p>{deliveryReceipt || (quote && locationAddress(quote.snapshot.location))}</p>{!attempt && <button type="button" className="checkout-text-button text-button" disabled={busy} onClick={() => changeStep('delivery')}>{pickup ? ui("storefront.change_pickup", "Change pickup") : ui("storefront.change_delivery", "Change delivery")}</button>}</CheckoutMessage>}
      {paymentStep && <>
      {embedded ? <>
        {!reviewStep && <CheckoutMessage label={ui("storefront.payment_question", "Payment question")}><h2 ref={stepHeading} tabIndex={-1}>{ui("storefront.how_would_you_like_to_pay", "How would you like to pay?")}</h2>
          {!reviewStep ? <><p>{ui("storefront.cash", "Cash")} {pickup ? ui("storefront.at_pickup", "at pickup") : ui("storefront.on_delivery", "on delivery")}  {ui("storefront.is_available_no_payment_is_collected_online", "is available. No payment is collected online.")}</p>
          <button type="button" className="checkout-primary" disabled={!canContinue} onClick={confirmPayment}>{ui("storefront.continue_to_review", "Continue to review")}</button>
          <p>{ui("storefront.or_reply_cash_to_continue", "Or reply “cash” to continue.")}</p>
          {(expired || quoteQuery.error) && <div role="status"><p>{quoteQuery.error ? ui("storefront.we_could_not_update_your_total", "We could not update your total.") : ui("storefront.your_total_has_expired", "Your total has expired.")}</p><button type="button" className="checkout-text-button text-button" disabled={!canQuote || quoteQuery.isFetching} onClick={() => void quoteQuery.refetch()}>{ui("storefront.refresh_total", "Refresh total")}</button></div>}
          </> : <p>{ui("storefront.your_payment_choice_is_recorded_below", "Your payment choice is recorded below.")}</p>}
        </CheckoutMessage>}
        {reviewStep && <CheckoutMessage label={ui("storefront.confirmed_payment", "Confirmed payment")} customer><p>{paymentReceipt || ui("storefront.cash_payment_confirmed", "Cash payment confirmed.")}</p>{!attempt && <button type="button" className="checkout-text-button text-button" disabled={busy} onClick={() => changeStep('payment')}>{ui("storefront.change_payment", "Change payment")}</button>}</CheckoutMessage>}
      </> : <section className="checkout-section"><h2>{ui("checkout.payment", "Payment")}</h2><p className="checkout-section-intro">{ui("storefront.pay_when_you_receive_your_order", "Pay when you receive your order.")}</p><div className="checkout-payment-card"><div className="checkout-method-card"><span className="checkout-selected-dot" aria-hidden="true"/><strong>{pickup?ui("storefront.cash_at_pickup", "Cash at pickup"):ui("checkout.cash_on_delivery", "Cash on delivery")}</strong><span className="checkout-cod-badge">{pickup ? ui("storefront.cash", "Cash") : ui("storefront.cod", "COD")}</span></div><p>{ui("storefront.no_card_details_needed_please_have_the_order_total_ready_when_you_receive_your_order", "No card details needed. Please have the order total ready when you receive your order.")}</p></div></section>}
      {reviewStep && <div className={embedded ? 'checkout-chat-message checkout-chat-review' : undefined}>
      {embedded && <><strong className="checkout-chat-speaker">{ui("storefront.rocento_assistant", "Rocento assistant")}</strong><h2 ref={stepHeading} tabIndex={-1}>{ui("storefront.review_your_order", "Review your order")}</h2><p>{ui("storefront.review_your_items_and_final_total_then_select_place_order", "Review your items and final total, then select Place order.")}</p>
        {quote && <p><strong>{pickup ? ui("checkout.pickup", "Pickup") : ui("storefront.deliver_to", "Deliver to")}:</strong> {locationAddress(quote.snapshot.location)}</p>}
        {quote?.snapshot.scheduled_delivery && <p>{ui("storefront.scheduled_for", "Scheduled for")} {new Date(quote.snapshot.scheduled_delivery.starts_at).toLocaleString(locale, {timeZone:quote.snapshot.scheduled_delivery.timezone})}</p>}
        <CheckoutSummary quote={quote} locked={!!attempt || !!restored.error} couponBusy={busy} onCouponPending={setCouponPending} onCouponChange={() => {setConsentedQuote(''); setRevision(value => value + 1);}} />
        {!attempt && quote && consentedQuote !== quote.id && <p role="status">{ui("storefront.the_order_details_changed_confirm_payment_again_before_placing_the_order", "The order details changed. Confirm payment again before placing the order.")}</p>}

      </>}
      <section className="checkout-confirmation" aria-label={ui("storefront.confirm_your_order", "Confirm your order")}>
        {embedded && !!submitError && <div ref={alertRef} tabIndex={-1} role="alert" className="checkout-alert"><strong>{ui("storefront.we_couldn_t_confirm_your_order", "We couldn’t confirm your order")}</strong><p>{message((submitError) || "")}</p>{attempt && <p>{ui("storefront.retry_below_to_confirm_the_same_submission", "Retry below to confirm the same submission.")}</p>}</div>}
        {!embedded && !attempt && <label className="checkout-consent"><input type="checkbox" checked={!!quote && consentedQuote === quote.id} disabled={!quote || expired || updating || !!quoteQuery.error || !!restored.error} onChange={event => setConsentedQuote(event.target.checked && quote ? quote.id : '')}/><span>{quote ? pickup ? ui("checkout.consent_pickup", "I confirm payment of {total} in cash at pickup.", {total}) : ui("checkout.consent_delivery", "I confirm payment of {total} in cash on delivery.", {total}) : pickup ? ui("storefront.i_confirm_cash_at_pickup_after_my_total_is_calculated", "I confirm cash at pickup after my total is calculated.") : ui("storefront.i_confirm_cash_on_delivery_after_my_total_is_calculated", "I confirm cash on delivery after my total is calculated.")}</span></label>}
        {!attempt && expired && quote && !updating && <div className="checkout-alert" role="status"><p>{ui("storefront.your_reviewed_total_has_expired_refresh_it_before_placing_your_order", "Your reviewed total has expired. Refresh it before placing your order.")}</p><button type="button" className="checkout-text-button text-button" onClick={() => void quoteQuery.refetch()}>{ui("storefront.refresh_total", "Refresh total")}</button></div>}
        {interfacePreview && <p className="interface-order-disabled" role="status">{ui("storefront.preview_order_disabled", "Order placement is disabled in this language preview.")}</p>}
        <button type="button" className="checkout-primary checkout-submit" disabled={interfacePreview || !canPlace} onClick={() => void placeOrder()}>{busy ? ui("storefront.confirming_your_order", "Confirming your order…") : attempt ? ui("storefront.retry_order_confirmation", "Retry order confirmation") : ui("checkout.place_order", "Place order") + (quote ? " · " + total : "")}</button>
        <p className="checkout-confirmation-note">{attempt ? ui("storefront.retrying_will_not_create_a_second_order", "Retrying will not create a second order.") : pickup ? ui("storefront.review_your_details_and_total_above_no_money_is_collected_until_pickup", "Review your details and total above. No money is collected until pickup.") : ui("storefront.review_your_details_and_total_above_no_money_is_collected_until_delivery", "Review your details and total above. No money is collected until delivery.")}</p>
      </section>
      </div>}
      </>}
      {embedded && replyNotice && <p className="checkout-chat-notice" role="status">{replyNotice}</p>}
    </>}
  </CheckoutLayout>;
}
