import { CommerceError, type CommerceClient, type DeliveryRequest, type Options, type Quote, type Slot } from './commerce';

export type CheckoutPhase = 'editing' | 'loadingOptions' | 'quoting' | 'ready' | 'submitting' | 'uncertain' | 'completed';
export type CheckoutState = Readonly<{
  phase: CheckoutPhase;
  quote: Quote | null;
  options: Options | null;
  windows: Readonly<Record<string, Slot>>;
  giftMessage: string;
}>;
const initial = (): CheckoutState => ({ phase: 'editing', quote: null, options: null, windows: {}, giftMessage: '' });
type CheckoutClient = Pick<CommerceClient, 'options' | 'quote' | 'place' | 'pending'>;

/** Synchronous transitions prevent double taps before React has rendered again. */
export class CheckoutFlow {
  private state = initial();
  private generation = 0;
  private listeners = new Set<() => void>();
  constructor(private client: CheckoutClient) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get busy() { return ['loadingOptions', 'quoting', 'submitting'].includes(this.state.phase); }
  get locked() { return ['submitting', 'uncertain'].includes(this.state.phase); }
  get giftMessageValid() { return new TextEncoder().encode(this.state.giftMessage).length <= 500; }
  private update(state: CheckoutState) { this.state = state; this.listeners.forEach(listener => listener()); }
  reset() { this.generation++; this.update(initial()); }
  invalidate() { if (!this.locked) { this.generation++; this.update({ ...initial(), giftMessage: this.state.giftMessage }); } }
  setGiftMessage(giftMessage: string) { if (!this.busy && !this.locked) this.update({ ...this.state, giftMessage, quote: null, phase: 'editing' }); }
  restore(quote: Quote | null) { this.reset(); if (quote) this.update({ ...initial(), phase: 'uncertain', quote, giftMessage: quote.snapshot.gift_message ?? '' }); }
  select(source: string, slot: Slot) {
    if (!this.busy && !this.locked) this.update({ ...this.state, phase: 'editing', quote: null, windows: { ...this.state.windows, [source]: slot } });
  }
  edit() { if (!this.busy && !this.locked) this.update({ ...this.state, phase: 'editing', quote: null }); }
  private checkEditable() { if (this.busy || this.locked) throw new CommerceError(409, 'Checkout is already in progress'); }
  private checkRevision(revision: number) { if (revision !== this.generation) throw new CommerceError(401, 'Checkout session changed'); }
  async findOptions(request: DeliveryRequest) {
    this.checkEditable(); this.invalidate();
    const revision = this.generation;
    this.update({ ...this.state, phase: 'loadingOptions' });
    try {
      const options = await this.client.options({ ...request }); this.checkRevision(revision);
      this.update({ ...this.state, phase: 'editing', options });
    } catch (error) {
      if (revision === this.generation) this.update({ ...this.state, phase: 'editing' });
      throw error;
    }
  }
  async review(request: DeliveryRequest) {
    this.checkEditable();
    if (!this.giftMessageValid) throw new CommerceError(422, 'Please shorten your gift message');
    const revision = this.generation;
    this.update({ ...this.state, phase: 'quoting', quote: null });
    try {
      const quote = await this.client.quote({ ...request }, Object.values(this.state.windows), this.state.giftMessage); this.checkRevision(revision);
      this.update({ ...this.state, phase: 'ready', quote });
    } catch (error) {
      if (revision === this.generation) this.update({ ...this.state, phase: 'editing' });
      throw error;
    }
  }
  async place() {
    const quote = this.state.quote;
    if (!quote || !['ready', 'uncertain'].includes(this.state.phase)) throw new CommerceError(409, 'Review your checkout before confirming');
    const revision = this.generation;
    this.update({ ...this.state, phase: 'submitting' });
    try {
      const order = await this.client.place(quote); this.checkRevision(revision);
      this.update({ ...initial(), phase: 'completed' });
      return order;
    } catch (error) {
      if (revision === this.generation) {
        this.update({ ...this.state, phase: 'uncertain' });
        try {
          const pending = await this.client.pending();
          if (revision === this.generation) this.update(pending ? { ...this.state, phase: 'uncertain', quote: pending.quote } : initial());
        } catch { /* An unreadable pending attempt must remain locked for recovery. */ }
      }
      throw error;
    }
  }
}
