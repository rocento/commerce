import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cartApi, customerApi, orderApi, locationAddress, setDeliveryPin, type Cart, type Location, type components } from '@commerce/api-client';
import { BasketProposalCard } from './shopping';
import { CartSummary } from './assistant-rich';
import { completeCartSnapshot } from './assistant-cart-pagination';
import { useCart } from './cart';
import { useAssistantSelection } from './assistant-selection';
import { reorderAddress, reorderCartSignature, sameReorderAddress } from './reorder-logic';

type Order = { id: string; number: number };
type Detail = Awaited<ReturnType<typeof orderApi.detail>>;
type Proposal = Awaited<ReturnType<typeof cartApi.proposal>>;
export function AssistantReorder({ order, disabled = false, header, autoStart = false }: { order: Order; disabled?: boolean; header?: ReactNode; autoStart?: boolean }) {
  const { setCart } = useCart();
  const selection = useAssistantSelection();
  const [stage, setStage] = useState<'idle'|'cart'|'address'|'review'|'done'>('idle');
  const [snapshot, setSnapshot] = useState<Cart>();
  const [detail, setDetail] = useState<Detail>();
  const [addresses, setAddresses] = useState<Location[]>([]);
  const [mode, setMode] = useState<'keep'|'replace'>('keep');
  const [proposal, setProposal] = useState<Proposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const started = useRef(false);
  const task = useRef(crypto.randomUUID());
  const pending = useRef<Proposal>();
  const chosenLocation = useRef<Location>();
  const blocked = disabled || busy;
  async function run(action: () => Promise<void>) {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The reorder could not be completed. Review the current cart and retry.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function completed(cart: Cart, location?: Location) {
    setCart(cart); setSnapshot(cart);
    if (location && cart.customer_id) {
      setDeliveryPin({latitude:location.latitude,longitude:location.longitude});
      sessionStorage.setItem(`commerce-active-location:${cart.customer_id}`, location.id);
      window.dispatchEvent(new Event('commerce-location'));
    }
    setStage('done');
  }
  async function commit(p: Proposal) {
    // Reuse the exact proposal ID after uncertain responses; never replay item additions.
    pending.current = p;
    sessionStorage.setItem(`assistant-reorder:${order.id}`, p.id);
    const fresh = await cartApi.proposal(p.id);
    if (fresh.applied) { await completed(await cartApi.open(), chosenLocation.current); return; }
    if (!fresh.can_apply || Date.parse(fresh.expires_at) <= Date.now()) {
      pending.current = undefined;
      sessionStorage.removeItem(`assistant-reorder:${order.id}`);
      setProposal(fresh); setStage('review');
      setError('This cart quote needs a fresh review. Update the options and refresh the quote below.');
      return;
    }
    await cartApi.confirmProposal(p.id, p.id);
    const cart = await cartApi.applyProposal(p.id, p.id);
    await completed(cart, chosenLocation.current);
  }
  async function build(location: Location, choice: 'keep'|'replace', expected: Cart) {
    const currentAddresses = await customerApi.locations();
    const currentLocation = currentAddresses.find(address => address.id === location.id);
    if (!currentLocation || !sameReorderAddress(location, currentLocation)) {
      setAddresses(currentAddresses); setStage('address');
      throw new Error('That address changed. Confirm the current address before continuing.');
    }
    chosenLocation.current = currentLocation;
    let latest = await cartApi.open();
    setCart(latest); setSnapshot(latest);
    if (reorderCartSignature(latest) !== reorderCartSignature(expected)) {
      setStage('cart'); throw new Error('Your cart changed. Review the updated cart and choose keep or replace again.');
    }
    if (choice === 'replace') {
      // Delete only the reviewed lines. Stop if any concurrent cart edit is observed.
      for (const item of expected.items) {
        const observed = await cartApi.open();
        if (reorderCartSignature(observed) !== reorderCartSignature(latest)) {
          setCart(observed); setSnapshot(observed); setStage('cart');
          throw new Error('Your cart changed while clearing it. Review the remaining items before continuing.');
        }
        try { latest = await cartApi.remove(item.product_id); }
        catch { setStage('cart'); const remaining = await cartApi.open(); setCart(remaining); setSnapshot(remaining); throw new Error('Clearing stopped before completion. Review the remaining cart and choose how to continue.'); }
        setCart(latest); setSnapshot(latest);
      }
    }
    const context = await cartApi.shoppingContext(task.current);
    const draft: components['schemas']['BasketDraft'] = {
      task_id: task.current, task_revision: context.task_revision, source_revision: context.source_revision,
      mode:'buy_again', auto_select:true, order_id:order.id, location_id:location.id, selections:[],
      goal:{purpose:`Reorder #${order.number}`,budget:null,currency:null,all_inclusive:false,budget_exclusive:false,people:null,locked_products:[],excluded_products:[],locked_brands:[],allow_substitutions:false,delivery_date:null,assumptions:[],unresolved:[],saving_target:null},
    };
    const p = await cartApi.propose(draft);
    setProposal(p); setStage('review');
    if (!p.can_apply || (p.execution && p.execution.verdict !== 'pass')) return;
    await commit(p);
  }
  async function choose(choice: 'keep'|'replace', current = snapshot!, previous = detail!, saved = addresses) {
    setMode(choice);
    const location = reorderAddress(previous.order.location, saved);
    if (!location) { setStage('address'); return; }
    await build(location, choice, current);
  }
  async function start() {
    const [current, previous, saved] = await Promise.all([cartApi.open(), orderApi.detail(order.id), customerApi.locations()]);
    setCart(current); setSnapshot(current); setDetail(previous); setAddresses(saved);
    const savedProposal = sessionStorage.getItem(`assistant-reorder:${order.id}`);
    if (savedProposal) {
      const p = await cartApi.proposal(savedProposal);
      setProposal(p); setStage('review');
      chosenLocation.current = saved.find(address => address.id === p.draft.location_id);
      await commit(p);
      return;
    }
    if (current.items.length) setStage('cart');
    else await choose('keep', current, previous, saved);
  }
  // Keep the automatic start current without rerunning its cart writes on renders.
  const startAction = useRef(() => run(start));
  useLayoutEffect(() => { startAction.current = () => run(start); });
  useEffect(() => {
    if (!autoStart || started.current || disabled) return;
    started.current = true;
    void startAction.current();
  }, [autoStart, disabled]);
  return <section className="assistant-order-reorder assistant-rich" aria-label={`Reorder order #${order.number}`}>
    {(header || stage === 'idle') && <div className="assistant-order-header">
      {header}
      {stage === 'idle' && <button type="button" className="assistant-reorder-action text-button" disabled={blocked} onClick={() => selection?.startReorder && !autoStart ? selection.startReorder(order) : void run(start)}>{busy ? 'Checking your order…' : 'Reorder'}</button>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {busy && stage !== 'idle' && <p role="status">Checking current prices, availability and your cart…</p>}
    {stage === 'cart' && <>
      <h3>Keep your cart or start fresh?</h3>
      {snapshot && <CartSummary cart={completeCartSnapshot(snapshot)} />}
      <div className="assistant-guide-actions">
        <button disabled={blocked} onClick={() => void run(() => choose('keep'))}>Keep cart and add order items</button>
        <button disabled={blocked} onClick={() => void run(() => choose('replace'))}>Empty cart and rebuild this order</button>
      </div>
    </>}
    {stage === 'address' && <>
      <h3>Confirm your delivery address</h3>
      <p>Your default address differs from the original order, or the original address is no longer available.</p>
      {detail && <p>Original order: {locationAddress(detail.order.location)}</p>}
      <ul className="assistant-address-list">{addresses.map(address => <li key={address.id}><strong>{address.custom_label || address.label}{address.is_default ? ' · Default' : ''}</strong><p>{locationAddress(address)}</p><p>{[address.building,address.floor,address.apartment].filter(Boolean).join(' · ')}</p><button disabled={blocked} onClick={() => void run(() => build(address, mode, snapshot!))}>Use this address</button></li>)}</ul>
      {!addresses.length && <p>Add a saved delivery address before continuing.</p>}
      <Link to="/account/locations">Manage addresses</Link>
      <button disabled={blocked} onClick={() => void run(async () => setAddresses(await customerApi.locations()))}>Refresh addresses</button>
    </>}
    {stage === 'review' && proposal && <>
      <p>Review the available options below. Unavailable products or changed product details need your choice.</p>
      {pending.current ? <button disabled={blocked} onClick={() => void run(() => commit(pending.current!))}>Check and finish cart update</button>
        : <BasketProposalCard id={proposal.id} onApplied={(cart, locationId) => { void run(async () => { const saved = await customerApi.locations(); await completed(cart, saved.find(a => a.id === locationId)); }); }} />}
      {snapshot && <CartSummary cart={completeCartSnapshot(snapshot)} />}
    </>}
    {stage === 'done' && snapshot && <>
      <h3>Your reorder cart is ready</h3>
      <CartSummary cart={completeCartSnapshot(snapshot)} />
      <p>Review delivery and the final total, then confirm Place order.</p>
      <button type="button" className="text-button" disabled={blocked} onClick={() => { sessionStorage.removeItem(`assistant-reorder:${order.id}`); pending.current = undefined; task.current = crypto.randomUUID(); setProposal(undefined); setStage('idle'); }}>Start another reorder</button>
      <button type="button" className="assistant-reorder-action text-button" disabled={blocked || !snapshot.items.length} onClick={() => selection?.startCheckout?.()}>Continue to checkout</button>
    </>}
  </section>;
}
