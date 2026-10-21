import { OrderStore } from './orderStore';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../shared/testing/commerce-flow.json';
import { OperationCoordinator } from './operations';
import { OperationCancelled } from './featureState';
import { DeliveryForm } from './delivery';
import { AccountStore } from './account';
import { CartStore } from './cart';
import { CheckoutFlow } from './checkout';
import { CommerceClient, merchant, type Cart, type Customer, type Pin } from './commerce';
import { ShoppingSession } from './shoppingSession';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const customer: Customer = { id: fixture.customer.id, email: fixture.customer.email, verified: fixture.customer.verified };
const checkout = () => new CheckoutFlow({ options: async () => fixture.options, quote: async () => fixture.quote, place: async () => fixture.detail, pending: async () => null });
const accountClient = () => ({
  restore: vi.fn(async (): Promise<Customer | null> => customer), login: vi.fn(async () => customer), logout: vi.fn(async () => {}),
  authAction: vi.fn(async () => ({})), request: async <T>() => customer as T,
  orders: vi.fn(async () => [fixture.order]), order: vi.fn(async () => fixture.detail),
});
const deliveryClient = () => ({ pin: null as Pin | null, locations: vi.fn(async () => fixture.locations), fulfillment: vi.fn(async () => fixture.availability),
  coverage: vi.fn(async () => ({ configured: true, deliverable: true })), saveLocation: vi.fn(async () => fixture.location) });
const cartClient = () => ({ cart: vi.fn(async () => fixture.cart), add: vi.fn(async () => fixture.cart), quantity: vi.fn(async () => fixture.cart), saveForLater: vi.fn(async () => fixture.empty_cart), coupon: vi.fn(async (_code: string): Promise<Cart> => fixture.cart) });

describe('operation coordination', () => {
  it('executes overlapping actions in order without dropping or overlapping them', async () => {
    const queue = new OperationCoordinator(), gate = deferred<void>(), events: string[] = [];
    const first = queue.run(async () => { events.push('start'); await gate.promise; events.push('finish'); });
    const second = queue.run(async () => { events.push('second'); });
    await Promise.resolve(); expect(events).toEqual(['start']); expect(queue.getSnapshot()).toMatchObject({ active: true, queued: 1, kind: 'mutation', busy: true });
    gate.resolve(); await Promise.all([first, second]); expect(events).toEqual(['start', 'finish', 'second']); expect(queue.busy).toBe(false);
  });
  it('releases the queue after failures and cancelled pending tasks', async () => {
    const queue = new OperationCoordinator(), signal = new AbortController(); signal.abort();
    await expect(queue.run(async () => {}, signal.signal)).rejects.toBeInstanceOf(OperationCancelled);
    await expect(queue.run(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(await queue.run(async () => 42)).toBe(42); expect(queue.busy).toBe(false);
  });
  it('cancels old-session queued work while allowing the active operation to finish', async () => {
    const queue = new OperationCoordinator(), gate = deferred<void>(), action = vi.fn(async () => {});
    const first = queue.run(() => gate.promise); await Promise.resolve();
    const second = queue.run(action); const cancelled = expect(second).rejects.toBeInstanceOf(OperationCancelled);
    queue.invalidatePending(); gate.resolve(); await first; await cancelled;
    expect(action).not.toHaveBeenCalled(); await queue.run(action); expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('delivery state', () => {
  it('changes delivery atomically and invalidates the reviewed quote outside view callbacks', async () => {
    const flow = checkout(), form = new DeliveryForm(deliveryClient(), flow);
    await form.refresh(); await flow.review(form.request); expect(flow.getSnapshot().phase).toBe('ready');
    form.update({ date: '2026-11-01', asap: false }); expect(flow.getSnapshot().quote).toBeNull();
    expect(form.request.date).toBe('2026-11-01'); expect(form.request.asap).toBe(false);
    flow.restore(fixture.quote); form.update({ method: 'pickup' }); expect(form.request.method).toBe('delivery'); expect(flow.locked).toBe(true);
  });
  it('does not commit an uncovered address or change the existing pin', async () => {
    const client = deliveryClient(), form = new DeliveryForm(client, checkout()); await form.refresh(); const old = client.pin;
    client.coverage.mockResolvedValue({ configured: true, deliverable: false });
    await expect(form.choose({ ...fixture.location, id: 'other', latitude: 1 })).rejects.toThrow('Outside');
    expect(client.pin).toEqual(old); expect(form.getSnapshot().locationID).toBe(fixture.location.id);
  });
  it('does not restore an old pin when a session resets during coverage lookup', async () => {
    const client = deliveryClient(), form = new DeliveryForm(client, checkout()), gate = deferred<{ configured: boolean; deliverable: boolean }>();
    client.coverage.mockImplementation(() => gate.promise);
    const choosing = form.choose(fixture.location); form.reset(); gate.resolve({ configured: true, deliverable: true });
    await expect(choosing).rejects.toBeInstanceOf(OperationCancelled); expect(client.pin).toBeNull(); expect(form.getSnapshot().locationID).toBe('');
  });
  it('selects a guest pin without saving a customer address and clears it on reset', async () => {
    const client = deliveryClient(), form = new DeliveryForm(client, checkout());
    form.editAddress({ address: 'Guest location', latitude: '30', longitude: '31' });
    await form.saveAddress(true);
    expect(client.saveLocation).not.toHaveBeenCalled(); expect(client.pin).toEqual({ latitude: 30, longitude: 31 });
    expect(form.getSnapshot().guestAddress).toBe('Guest location'); expect(form.request.location_id).toBeNull();
    form.reset(); expect(client.pin).toBeNull(); expect(form.getSnapshot().guestAddress).toBeNull();
  });
  it('does not replace the previous guest location when coverage rejects the new pin', async () => {
    const client = deliveryClient(), form = new DeliveryForm(client, checkout());
    form.editAddress({ address: 'First', latitude: '30', longitude: '31' }); await form.saveAddress(true);
    client.coverage.mockResolvedValue({ configured: true, deliverable: false });
    form.editAddress({ address: 'Outside', latitude: '40', longitude: '41' });
    await expect(form.saveAddress(true)).rejects.toThrow('Outside');
    expect(client.pin).toEqual({ latitude: 30, longitude: 31 }); expect(form.getSnapshot().guestAddress).toBe('First');
  });
  it('saves manual neighborhood metadata with area coordinates and street details', async () => {
    const client = deliveryClient(), form = new DeliveryForm(client, checkout());
    const geography = { country_code: 'EG', state_code: 'C', state_name: 'Cairo', city_id: '360630', city_name: 'Cairo' };
    form.editAddress({ locationMethod: 'neighborhood', geography, address: '12 Test Street', building: '12', latitude: '30', longitude: '31' });
    await form.saveAddress();
    expect(client.saveLocation).toHaveBeenCalledWith(expect.objectContaining({ location_method: 'neighborhood', geography, latitude: 30, longitude: 31, formatted_address: '12 Test Street', building: '12' }));
    expect(form.getSnapshot().addressDraft.locationMethod).toBe('pin');
    expect(form.getSnapshot().addressDraft.geography).toBeNull();
  });
  it('resets address drafts and rejects invalid coordinates before a request', async () => {
    const client = deliveryClient(), form = new DeliveryForm(client, checkout());
    form.editAddress({ address: 'A', latitude: 'bad', longitude: '31' }); await expect(form.saveAddress()).rejects.toThrow('valid'); expect(client.coverage).not.toHaveBeenCalled();
    form.reset(); expect(form.getSnapshot().addressDraft.address).toBe('');
  });
});

describe('account and cart ownership', () => {
  it('invalidates a reviewed quote for coupons, accepts server errors, and blocks unresolved checkout edits', async () => {
    const flow = checkout(), client = cartClient(), cart = new CartStore(client, flow);
    await flow.review({ method: 'delivery', location_id: fixture.ids.location, source_id: null, date: '2026-10-13', asap: true });
    client.coupon.mockImplementation(async code => {
      expect(flow.getSnapshot().quote).toBeNull();
      return { ...fixture.cart, coupon_code: code || null, coupon_error: code === 'BAD' ? 'Invalid code' : null, discount_amount: code === 'SAVE5' ? '5.00' : '0.00' };
    });
    await cart.coupon('SAVE5'); expect(cart.getSnapshot()?.discount_amount).toBe('5.00');
    await cart.coupon('BAD'); expect(cart.getSnapshot()?.coupon_error).toBe('Invalid code');
    await cart.coupon(''); expect(cart.getSnapshot()?.coupon_code).toBeNull();
    flow.restore(fixture.quote);
    await expect(cart.coupon('SAVE5')).rejects.toThrow('Resolve');
    expect(client.coupon).toHaveBeenCalledTimes(3);
  });
  it('preserves cart on failed coupon writes and ignores responses from a previous account', async () => {
    const client = cartClient(), cart = new CartStore(client, checkout()); cart.accept(fixture.cart);
    client.coupon.mockRejectedValueOnce(new Error('offline'));
    await expect(cart.coupon('SAVE5')).rejects.toThrow('offline'); expect(cart.getSnapshot()).toEqual(fixture.cart);
    const pending = deferred<Cart>(); client.coupon.mockImplementation(() => pending.promise);
    const applying = cart.coupon('SAVE5'); cart.reset(); pending.resolve({ ...fixture.cart, coupon_code: 'SAVE5' });
    await expect(applying).rejects.toBeInstanceOf(OperationCancelled); expect(cart.getSnapshot()).toBeNull();
  });
  it('discards late login responses after a session reset', async () => {
    const client = accountClient(), store = new AccountStore(client), gate = deferred<Customer>(); client.login.mockImplementation(() => gate.promise);
    const login = store.login('fixture', 'password'); store.reset(); gate.resolve(customer);
    await expect(login).rejects.toBeInstanceOf(OperationCancelled); expect(store.getSnapshot().customer).toBeNull();
  });
  it('keeps history across refresh failures but clears it on logout', async () => {
    const client = accountClient(), account = new AccountStore(client), store = new OrderStore(client);
    account.onIdentityChange = () => store.reset();
    await account.login('fixture', 'password'); await store.refresh(); client.orders.mockRejectedValue(new Error('offline'));
    await expect(store.refresh()).rejects.toThrow('offline'); expect(store.getSnapshot().orders).toHaveLength(1);
    await account.logout(); expect(store.getSnapshot().orders).toEqual([]); expect(store.getSnapshot().detail).toBeNull();
  });
  it('rejects late order history and cart responses after reset', async () => {
    const client = accountClient(), account = new OrderStore(client), orders = deferred<typeof fixture.order[]>(); client.orders.mockImplementation(() => orders.promise);
    const loading = account.refresh(); account.reset(); orders.resolve([fixture.order]); await expect(loading).rejects.toBeInstanceOf(OperationCancelled);
    const cart = new CartStore(cartClient(), checkout()), response = deferred<Cart>(); const mutation = cart.mutate(() => response.promise);
    cart.reset(); response.resolve(fixture.cart); await expect(mutation).rejects.toBeInstanceOf(OperationCancelled); expect(cart.getSnapshot()).toBeNull();
  });
  it('blocks cart mutations during unresolved checkout and invalidates a normal quote before a request', async () => {
    const flow = checkout(), client = cartClient(), cart = new CartStore(client, flow);
    flow.restore(fixture.quote); await expect(cart.quantity(fixture.ids.product, 2)).rejects.toThrow('Resolve'); expect(client.quantity).not.toHaveBeenCalled();
    flow.reset(); await flow.review({ method: 'delivery', location_id: fixture.ids.location, source_id: null, date: '2026-10-13', asap: true });
    await cart.mutate(async () => { expect(flow.getSnapshot().quote).toBeNull(); return fixture.cart; }); expect(cart.getSnapshot()).toEqual(fixture.cart);
  });
  it('does not replace a valid cart when a mutation fails', async () => {
    const cart = new CartStore(cartClient(), checkout()); cart.accept(fixture.cart);
    await expect(cart.mutate(async () => { throw new Error('rejected'); })).rejects.toThrow('rejected'); expect(cart.getSnapshot()).toEqual(fixture.cart);
  });
  it('resets all customer state while preserving persisted checkout attempts', async () => {
    const storage = new Map<string, string>(); const pendingKey = `rocento.rn.v1.production.${merchant.id}.checkout.${fixture.customer.id}`;
    storage.set(pendingKey, JSON.stringify({ customerID: fixture.customer.id, quote: fixture.quote, key: 'saved-key' }));
    const client = new CommerceClient(async () => { const result = new Response(JSON.stringify(fixture.auth)); Object.defineProperty(result, 'headers', { value: { get: () => `customer_refresh=${'f'.repeat(64)}; HttpOnly` } }); return result; },
      { get: async key => storage.get(key) ?? null, set: async (key, value) => { if (value === null) storage.delete(key); else storage.set(key,value); } }, () => '00000000-0000-4000-8000-000000000001');
    const session = new ShoppingSession(client); await session.account.login('fixture','password'); session.cart.accept(fixture.cart); session.delivery.editAddress({ address: 'private' }); session.checkout.restore(fixture.quote);
    session.account.reset(); expect(session.cart.getSnapshot()).toBeNull(); expect(session.checkout.locked).toBe(false); expect(session.delivery.getSnapshot().addressDraft.address).toBe('');
    expect(storage.get(pendingKey)).toContain('saved-key');
  });
});
