import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../shared/testing/commerce-flow.json';
import { ReorderStore, type ReorderProposal, type ReorderTask } from './reorder';
import { CheckoutFlow } from './checkout';
import { CommerceClient, type Cart, type Location } from './commerce';

const taskID = '80000000-0000-4000-8000-000000000001';
const proposalID = '80000000-0000-4000-8000-000000000002';
const proposal = (): ReorderProposal => ({ id: proposalID, applied: false, can_apply: true, expires_at: '2099-01-01T00:00:00Z', issues: [], notes: [], lines: [], current_items: [], resulting_items: [], after: { payable: '30', currency: 'EGP' }, draft: { task_id: taskID, task_revision: 1, source_revision: 0, order_id: fixture.order.id, location_id: fixture.location.id, mode: 'buy_again', auto_select: false, goal: {}, selections: [{ product_id: fixture.variant.id, quantity: 1, replaces: null, required_attributes: {}, reason: 'Reorder' }] } });
function setup() {
  const saved = { task: taskID, pending: false };
  const client = {
    cart: vi.fn(async (): Promise<Cart> => fixture.cart), locations: vi.fn(async (): Promise<Location[]> => fixture.locations), quantity: vi.fn(async () => fixture.empty_cart),
    reorderTask: vi.fn(async () => ({ ...saved })), saveReorderTask: vi.fn(async (_order: string, task: ReorderTask) => { Object.assign(saved, task); }),
    reorderContext: vi.fn(async () => ({ source_revision: 0, task_revision: 0, proposal_id: null as string | null, cancelled: false })),
    reorderProposal: vi.fn(async () => proposal()), proposeReorder: vi.fn(async () => proposal()), applyAssistantProposal: vi.fn(async () => fixture.cart),
  };
  const checkout = new CheckoutFlow({ options: async () => fixture.options, quote: async () => fixture.quote, pending: async () => null, place: async () => fixture.detail });
  const accept = vi.fn(), store = new ReorderStore(client, checkout, accept);
  return { store, client, checkout, accept, saved };
}
describe('reviewed reorder', () => {
  it('loads relationships with customer, delivery and locale context and bounded sources', async () => {
    const calls: {url:string;init:RequestInit}[]=[];
    const client=new CommerceClient(async (url,init) => {calls.push({url,init});return new Response(JSON.stringify(url.includes('/auth/') ? fixture.auth : []),{headers:{'set-cookie':`customer_refresh=${'r'.repeat(64)}; HttpOnly`}});},{get:async()=>null,set:async()=>{}},()=>taskID);
    await client.login('fixture','test');client.locale='ar';client.pin={latitude:30,longitude:31};
    await client.relationships([fixture.variant.id,fixture.variant.id],'cross_sell');
    expect(()=>client.relationships([],'related')).toThrow();expect(()=>client.relationships(Array(51).fill(fixture.variant.id),'related')).toThrow();
    expect(calls).toHaveLength(2);
    const request=calls[1]!,headers=new Headers(request.init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${fixture.auth.access_token}`);expect(headers.get('X-Delivery-Latitude')).toBe('30');expect(headers.get('X-Storefront-Locale')).toBe('ar');
    expect(new URL(request.url).searchParams.get('sources')).toBe(fixture.variant.id);
  });
  it('keeps cart until approval and uses the saved proposal ID to apply', async () => {
    const { store, client, saved } = setup();
    await store.start(fixture.order); await store.prepare(fixture.location.id, false);
    expect(client.quantity).not.toHaveBeenCalled(); expect(client.applyAssistantProposal).not.toHaveBeenCalled();
    client.applyAssistantProposal.mockImplementation(async () => { expect(saved.pending).toBe(true); return fixture.cart; });
    await store.approve(); expect(client.applyAssistantProposal).toHaveBeenCalledWith(proposalID); expect(store.getSnapshot().done).toBe(true);
  });
  it('rejects a changed cart or address before deleting any item', async () => {
    const { store, client } = setup(); await store.start(fixture.order);
    client.cart.mockResolvedValue({ ...fixture.cart, items: [{ ...fixture.cart.items[0]!, quantity: 2 }] });
    await expect(store.prepare(fixture.location.id, true)).rejects.toThrow('cart changed'); expect(client.quantity).not.toHaveBeenCalled();
    client.locations.mockResolvedValue([{ ...fixture.location, updated_at: 'new', floor: 'changed' }]);
    await expect(store.prepare(fixture.location.id, true)).rejects.toThrow('address changed'); expect(client.proposeReorder).not.toHaveBeenCalled();
  });
  it('clears only reviewed items when replace was explicitly selected', async () => {
    const { store, client } = setup(); await store.start(fixture.order); await store.prepare(fixture.location.id, true);
    expect(client.quantity).toHaveBeenCalledExactlyOnceWith(fixture.variant.id, 0); expect(client.applyAssistantProposal).not.toHaveBeenCalled();
  });
  it('reloads remaining items after an interrupted delete without replaying it', async () => {
    const { store, client } = setup(); await store.start(fixture.order);
    client.quantity.mockRejectedValue(new Error('offline'));
    await expect(store.prepare(fixture.location.id, true)).rejects.toThrow('offline');
    expect(client.quantity).toHaveBeenCalledTimes(1); expect(client.proposeReorder).not.toHaveBeenCalled();
  });
  it('recovers an applied proposal after a lost response without applying it twice', async () => {
    const { store, client, checkout, accept, saved } = setup(); await store.start(fixture.order); await store.prepare(fixture.location.id, false);
    client.applyAssistantProposal.mockRejectedValue(new Error('reply lost'));
    await expect(store.approve()).rejects.toThrow('reply lost'); expect(saved.pending).toBe(true);
    client.reorderContext.mockResolvedValue({ source_revision: 1, task_revision: 1, proposal_id: proposalID, cancelled: false });
    client.reorderProposal.mockResolvedValue({ ...proposal(), applied: true });
    const restarted = new ReorderStore(client, checkout, accept); await restarted.start(fixture.order);
    expect(restarted.getSnapshot().done).toBe(true); expect(client.applyAssistantProposal).toHaveBeenCalledTimes(1);
  });
  it('blocks checkout uncertainty, storage failures, and late responses after account reset', async () => {
    const { store, client, checkout } = setup(); checkout.restore(fixture.quote);
    await expect(store.start(fixture.order)).rejects.toThrow('checkout'); expect(client.cart).not.toHaveBeenCalled(); checkout.reset();
    await store.start(fixture.order); await store.prepare(fixture.location.id, false);
    client.saveReorderTask.mockRejectedValue(new Error('storage failed'));
    await expect(store.approve()).rejects.toThrow('storage'); expect(client.applyAssistantProposal).not.toHaveBeenCalled();
    let finish!: (value: Cart) => void; client.cart.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = store.start(fixture.order); await Promise.resolve(); await Promise.resolve(); store.reset(); finish(fixture.cart);
    await expect(pending).rejects.toThrow('previous session'); expect(store.getSnapshot().order).toBeNull();
  });
  it('cannot apply expired or blocked proposals and refreshes under the same task', async () => {
    const { store, client } = setup(); await store.start(fixture.order); await store.prepare(fixture.location.id, false);
    client.reorderProposal.mockResolvedValue({ ...proposal(), expires_at: '2000-01-01T00:00:00Z' });
    await expect(store.approve()).rejects.toThrow('fresh review'); expect(client.applyAssistantProposal).not.toHaveBeenCalled();
    await store.revise(proposal().draft.selections); expect(client.proposeReorder).toHaveBeenLastCalledWith(taskID, fixture.order.id, fixture.location.id, proposal().draft.selections);
  });
  it('persists task IDs across client recreation and fails closed on unreadable storage', async () => {
    const memory = new Map<string,string>(); const storage = { get: async (key:string) => memory.get(key) ?? null, set: async (key:string,value:string|null) => { if(value==null)memory.delete(key);else memory.set(key,value); } };
    const transport = async () => new Response(JSON.stringify(fixture.auth), { headers: { 'set-cookie': `customer_refresh=${'r'.repeat(64)}; HttpOnly` } });
    const first = new CommerceClient(transport,storage,()=>taskID); await first.login('fixture','password');
    await first.reorderTask(fixture.order.id); await first.saveReorderTask(fixture.order.id,{task:taskID,pending:true});
    const next = new CommerceClient(transport,storage,()=>proposalID); await next.restore();
    expect(await next.reorderTask(fixture.order.id)).toEqual({task:taskID,pending:true});
    storage.get = async () => { throw new Error('storage unavailable'); };
    await expect(next.reorderTask(fixture.order.id)).rejects.toThrow('storage unavailable');
  });
});
