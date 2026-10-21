import { expect, it, vi } from 'vitest';
import { WishlistStore } from './wishlistStore';
import { NotificationsStore, memoryNotificationStorage } from './notificationsStore';
import { CommerceError, type LiveProduct, type Locale, type OrderDetail } from './commerce';
import { OperationCancelled } from './featureState';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const product = (id: string): LiveProduct => ({ id, name: id, price: '1', currency: 'USD', description: '', in_stock: true });
const wishlist = () => ({ locale: 'en' as Locale, wishlist: vi.fn(async () => ['a', 'missing']), product: vi.fn(async (id: string) => { if (id === 'missing') throw new CommerceError(404, 'gone'); return product(id); }), saveProduct: vi.fn(async () => ({})) });
const detail = (id: string): OrderDetail => ({ order: { id, number: 1, status: 'placed', total: '1', currency: 'USD', created_at: '2026-10-01T00:00:00Z' }, history: [{ id: 'event', status: 'placed', created_at: '2026-10-01T00:00:00Z' }] });
const inbox = () => ({ orders: vi.fn(async (_offset = 0) => [detail('a').order]), order: vi.fn(async (id: string) => detail(id)) });
it('wishlist keeps missing entries removable and pages by resolved IDs', async () => {
  const client = wishlist(), ids = Array.from({ length: 25 }, (_, i) => String(i)); client.wishlist.mockResolvedValue(ids);
  client.product.mockImplementation(async id => { if (id === '0') throw new CommerceError(404, 'gone'); return product(id); });
  const store = new WishlistStore(client); await store.load('en'); expect(Object.keys(store.getSnapshot().products)).toHaveLength(24); expect(store.getSnapshot().products['0']).toBeNull();
  await store.load('en', true); expect(Object.keys(store.getSnapshot().products)).toHaveLength(25);
  await store.save('0', false); expect(store.getSnapshot().ids).not.toContain('0');
});
it('wishlist failures preserve the last complete snapshot and failed removes do not disappear', async () => {
  const client = wishlist(), store = new WishlistStore(client); await store.load('en'); client.product.mockRejectedValue(new Error('offline'));
  await expect(store.load('en')).rejects.toThrow('offline'); expect(store.getSnapshot().products.a?.id).toBe('a');
  client.saveProduct.mockRejectedValue(new Error('offline')); await expect(store.save('a', false)).rejects.toThrow(); expect(store.getSnapshot().ids).toContain('a');
});
it('wishlist discards old-session reads and mutations', async () => {
  const client = wishlist(), gate = deferred<string[]>(); client.wishlist.mockImplementationOnce(() => gate.promise);
  const store = new WishlistStore(client), load = store.load('en'); store.reset(); gate.resolve(['private']);
  await expect(load).rejects.toBeInstanceOf(OperationCancelled); expect(client.product).not.toHaveBeenCalled();
  const saved = deferred<object>(); client.saveProduct.mockImplementationOnce(() => saved.promise);
  const mutation = store.save('private', true, product('private')); store.reset(); saved.resolve({}); await expect(mutation).rejects.toBeInstanceOf(OperationCancelled); expect(store.getSnapshot().ids).toEqual([]);
});
it('wishlist locale changes clear stale translations even when fetching fails', async () => {
  const client = wishlist(), store = new WishlistStore(client); await store.load('en'); client.product.mockRejectedValue(new Error('offline'));
  await expect(store.load('ar')).rejects.toThrow(); expect(store.getSnapshot().products).toEqual({}); expect(store.getSnapshot().loaded).toBe(false);
});
it('notification read markers are scoped and survive store recreation', async () => {
  const client = inbox(), storage = memoryNotificationStorage(), store = new NotificationsStore(client, storage);
  await store.refresh('alice'); await store.mark([store.events[0]!.id, 'unknown']); expect(store.unread).toHaveLength(0);
  await store.refresh('bob'); expect(store.unread).toHaveLength(1);
  const restored = new NotificationsStore(client, storage); await restored.refresh('alice'); expect(restored.unread).toHaveLength(0); expect(restored.getSnapshot().read).toHaveLength(1);
});
it('notification refresh is atomic and paging uses order count', async () => {
  const client = inbox(), store = new NotificationsStore(client); await store.refresh('alice');
  client.orders.mockResolvedValue([detail('b').order, detail('c').order]); client.order.mockImplementation(async id => { if (id === 'c') throw new Error('offline'); return detail(id); });
  await expect(store.refresh('alice', true)).rejects.toThrow(); expect(store.events.map(v => v.order)).toEqual(['a']); expect(store.getSnapshot().offset).toBe(1);
  client.order.mockImplementation(async id => detail(id)); await store.refresh('alice', true); expect(client.orders.mock.lastCall?.[0]).toBe(1); expect(store.events).toHaveLength(3);
});
it('notification reset during a request rejects late private results', async () => {
  const client = inbox(), gate = deferred<OrderDetail>(); client.order.mockImplementation(() => gate.promise);
  const store = new NotificationsStore(client); await store.bind('alice'); const refresh = store.refresh('alice');
  await vi.waitFor(() => expect(client.order).toHaveBeenCalled()); store.reset(); gate.resolve(detail('a'));
  await expect(refresh).rejects.toBeInstanceOf(OperationCancelled); expect(store.events).toEqual([]);
});
it('paused notifications do not fetch and the setting persists', async () => {
  const client = inbox(), storage = memoryNotificationStorage(), store = new NotificationsStore(client, storage);
  await store.bind('alice'); await store.setEnabled(false); await store.refresh('alice'); expect(client.orders).not.toHaveBeenCalled();
  const restored = new NotificationsStore(client, storage); await restored.refresh('alice'); expect(restored.getSnapshot().enabled).toBe(false); expect(client.orders).not.toHaveBeenCalled();
});
