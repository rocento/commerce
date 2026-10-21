import { CommerceError, type Cart, type CommerceClient, type Location, type Order } from './commerce';
import { CheckoutFlow } from './checkout';
import { FeatureState } from './featureState';

export interface ReorderSelection { product_id: string; quantity: number; replaces: string | null; required_attributes: Record<string, unknown>; reason: string }
export interface ReorderDraft { task_id: string; task_revision: number; source_revision: number; mode: 'buy_again'; auto_select: boolean; order_id: string; location_id: string; selections: ReorderSelection[]; goal: Record<string, unknown> }
export interface ReorderProposal {
  id: string; draft: ReorderDraft; expires_at: string; applied: boolean; can_apply: boolean;
  execution?: { verdict: string }; issues: string[]; notes: string[];
  current_items: { product_id: string; name: string; quantity: number; line_total: string; currency?: string }[];
  resulting_items: { product_id: string; name: string; quantity: number; line_total: string; currency: string }[];
  lines: { selection: ReorderSelection; product: { name: string } | null; historical_price: string | null; available: number }[];
  after: { payable: string | null; currency: string };
}
export interface ReorderTask { task: string; pending: boolean }
export interface ReorderContext { task_revision: number; source_revision: number; proposal_id: string | null; cancelled: boolean }
type Client = Pick<CommerceClient, 'cart' | 'locations' | 'quantity' | 'reorderTask' | 'saveReorderTask' | 'reorderContext' | 'reorderProposal' | 'proposeReorder' | 'applyAssistantProposal'>;
interface State { order: Order | null; cart: Cart | null; locations: Location[]; proposal: ReorderProposal | null; task: ReorderTask | null; busy: boolean; pending: boolean; done: boolean }
const initial = (): State => ({ order: null, cart: null, locations: [], proposal: null, task: null, busy: false, pending: false, done: false });
export const reorderCartSignature = (cart: Cart) => JSON.stringify(cart.items.map(i => [i.product_id, i.quantity, i.price]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
const sameAddress = (a: Location, b: Location) => ['formatted_address', 'latitude', 'longitude', 'building', 'floor', 'apartment', 'delivery_instructions', 'updated_at', 'location_method'].every(key => a[key as keyof Location] === b[key as keyof Location]) && JSON.stringify(a.geography ?? null) === JSON.stringify(b.geography ?? null);

export class ReorderStore extends FeatureState<State> {
  constructor(private client: Client, private checkout: CheckoutFlow, private acceptCart: (cart: Cart) => void) { super(initial()); }
  reset() { this.generation++; this.publish(initial()); }
  private async work(operation: (check: () => void) => Promise<void>) {
    if (this.state.busy || this.checkout.locked) throw new CommerceError(409, 'Resolve the previous checkout first');
    const revision = this.generation; const check = () => this.checkRevision(revision);
    this.publish({ ...this.state, busy: true });
    try { await operation(check); } finally { if (revision === this.generation) this.publish({ ...this.state, busy: false }); }
  }
  async start(order: Order, again = false) {
    if (again && (!this.state.done || this.state.order?.id !== order.id)) throw new CommerceError(409, 'Check the previous reorder first');
    await this.work(async check => {
      this.publish({ ...initial(), order, busy: true });
      const task = await this.client.reorderTask(order.id, again); check();
      const cart = await this.client.cart(); check();
      const locations = await this.client.locations(); check();
      const context = await this.client.reorderContext(task.task); check();
      const proposal = context.proposal_id ? await this.client.reorderProposal(context.proposal_id) : null; check();
      if (task.pending && !proposal) throw new CommerceError(409, 'The previous basket update cannot be confirmed. Retry loading it.');
      this.publish({ ...this.state, task, cart, locations, proposal, pending: task.pending && !proposal?.applied, done: proposal?.applied === true });
      this.acceptCart(cart);
    });
  }
  async prepare(locationID: string, replace: boolean) {
    await this.work(async check => {
      const { order, task, cart: expected, locations, pending, done } = this.state;
      if (!order || !task || !expected || pending || done) throw new CommerceError(409, 'Reload the reorder before changing it');
      const location = locations.find(l => l.id === locationID);
      const fresh = await this.client.locations(); check(); this.publish({ ...this.state, locations: fresh });
      if (!location || !fresh.some(l => l.id === locationID && sameAddress(l, location))) throw new CommerceError(409, 'That address changed. Confirm the current address.');
      let cart = await this.client.cart(); check(); this.acceptCart(cart); this.publish({ ...this.state, cart, proposal: null });
      if (reorderCartSignature(cart) !== reorderCartSignature(expected)) throw new CommerceError(409, 'Your cart changed. Review it and choose keep or replace again.');
      if (replace) for (const item of expected.items) {
        const observed = await this.client.cart(); check();
        if (reorderCartSignature(observed) !== reorderCartSignature(cart)) { this.acceptCart(observed); this.publish({ ...this.state, cart: observed }); throw new CommerceError(409, 'Your cart changed while clearing it. Review the remaining items.'); }
        this.checkout.invalidate();
        try { cart = await this.client.quantity(item.product_id, 0); check(); }
        catch (error) { check(); const remaining = await this.client.cart(); check(); this.acceptCart(remaining); this.publish({ ...this.state, cart: remaining }); throw error; }
        this.acceptCart(cart); this.publish({ ...this.state, cart });
      }
      const proposal = await this.client.proposeReorder(task.task, order.id, locationID); check(); this.publish({ ...this.state, proposal });
    });
  }
  async revise(selections: ReorderSelection[]) {
    await this.work(async check => {
      const p = this.state.proposal;
      if (!p || this.state.done || !selections.length || selections.some(s => !Number.isInteger(s.quantity) || s.quantity < 1 || s.quantity > 1_000_000)) throw new CommerceError(422, 'Choose at least one item with a valid quantity');
      // The same task's server revision rejects a new proposal if its old one applied.
      const proposal = await this.client.proposeReorder(p.draft.task_id, p.draft.order_id, p.draft.location_id, selections); check(); this.publish({ ...this.state, proposal });
      await this.client.saveReorderTask(p.draft.order_id, { task: p.draft.task_id, pending: false }); check(); this.publish({ ...this.state, pending: false });
    });
  }
  async approve() {
    await this.work(async check => {
      const { order, task, proposal } = this.state;
      if (!order || !task || !proposal) throw new CommerceError(409, 'Review a basket first');
      const fresh = await this.client.reorderProposal(proposal.id); check(); this.publish({ ...this.state, proposal: fresh });
      if (!fresh.applied) {
        if (!fresh.can_apply || !(Date.parse(fresh.expires_at) > Date.now()) || (fresh.execution && fresh.execution.verdict !== 'pass')) throw new CommerceError(409, 'This proposal needs a fresh review');
        await this.client.saveReorderTask(order.id, { ...task, pending: true }); check(); this.publish({ ...this.state, pending: true }); this.checkout.invalidate();
        const cart = await this.client.applyAssistantProposal(fresh.id); check(); this.acceptCart(cart);
      }
      const cart = await this.client.cart(); check(); this.acceptCart(cart);
      await this.client.saveReorderTask(order.id, { ...task, pending: false }); check(); this.publish({ ...this.state, cart, done: true, pending: false });
    });
  }
}
