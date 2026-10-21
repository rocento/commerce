import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cart, CartItem } from '@commerce/api-client';
import { CartQuantityQueue, cartQuantityCount } from './cart-quantity';

function makeCart(quantities: Record<string, number> = {}): Cart {
  const items: CartItem[] = Object.entries(quantities).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => ({
    product_id: id, name: id, sku: id, unit: 'each', price: '2.00', currency: 'USD',
    quantity, reserved_quantity: quantity, available: 10, expires_at: null, line_total: (quantity * 2).toFixed(2),
  }));
  return { id: 'cart', customer_id: null, items, subtotal: String(items.reduce((sum, item) => sum + Number(item.line_total), 0)), currency: 'USD', fully_reserved: true, discount_amount: '0', discount_snapshot: [], coupon_code: null, coupon_error: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(initial: Record<string, number> = {}) {
  let cart = makeCart(initial);
  const save = vi.fn(async (id: string, quantity: number) => makeCart({ ...Object.fromEntries(cart.items.map(item => [item.product_id, item.quantity])), [id]: quantity }));
  const refresh = vi.fn(async () => cart);
  const write = vi.fn((value: Cart) => { cart = value; });
  const start = vi.fn(), settled = vi.fn();
  const queue = new CartQuantityQueue({ read: () => cart, write, save, refresh, start, settled });
  return { queue, save, refresh, write, start, settled, cart: () => cart };
}

describe('optimistic cart quantities', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('updates the shared quantity and badge immediately, combining rapid taps into one write', async () => {
    const { queue, save, cart, start, settled } = setup({ pears: 2 });
    for (let n = 0; n < 5; n++) queue.change('apples', 1, 10);
    expect(queue.getSnapshot().pending.apples.quantity).toBe(5);
    expect(cartQuantityCount(cart(), queue.getSnapshot().pending)).toBe(7);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180);
    expect(save).toHaveBeenCalledExactlyOnceWith('apples', 5);
    expect(queue.getSnapshot().pending).toEqual({});
    expect(cartQuantityCount(cart(), queue.getSnapshot().pending)).toBe(7);
    expect(start).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith(['apples']);
  });

  it('keeps newer taps visible while a slow response arrives and serializes writes across products', async () => {
    const { queue, save, cart } = setup();
    const first = deferred<Cart>(), second = deferred<Cart>();
    save.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    queue.change('apples', 1, 10);
    await vi.advanceTimersByTimeAsync(180);
    queue.change('apples', 1, 10);
    queue.change('apples', 1, 10);
    queue.change('pears', 1, 10);
    expect(cartQuantityCount(cart(), queue.getSnapshot().pending)).toBe(4);
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve(makeCart({ apples: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getSnapshot().pending.apples.quantity).toBe(3);
    expect(cartQuantityCount(cart(), queue.getSnapshot().pending)).toBe(4);
    expect(save).toHaveBeenNthCalledWith(2, 'apples', 3);
    expect(save).toHaveBeenCalledTimes(2);
    second.resolve(makeCart({ apples: 3 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenNthCalledWith(3, 'pears', 1);
    expect(cartQuantityCount(cart(), queue.getSnapshot().pending)).toBe(4);
    expect(queue.getSnapshot().pending).toEqual({});
  });

  it('skips a cancelled add before dispatch and removes an add already in flight', async () => {
    const { queue, save, cart } = setup();
    queue.change('apples', 1, 10);
    queue.change('apples', -1, 10);
    await vi.advanceTimersByTimeAsync(180);
    expect(save).not.toHaveBeenCalled();
    const first = deferred<Cart>();
    save.mockReturnValueOnce(first.promise);
    queue.change('apples', 1, 10);
    await vi.advanceTimersByTimeAsync(180);
    queue.change('apples', -1, 10);
    expect(cartQuantityCount(cart(), queue.getSnapshot().pending)).toBe(0);
    first.resolve(makeCart({ apples: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenNthCalledWith(2, 'apples', 0);
    expect(cart().items).toEqual([]);
  });

  it('keeps the stock ceiling stable during a burst and still allows decreases', async () => {
    const { queue, save } = setup({ apples: 1 });
    queue.change('apples', 1, 3);
    queue.change('apples', 1, 99);
    queue.change('apples', 1, 99);
    expect(queue.getSnapshot().pending.apples.quantity).toBe(3);
    queue.change('apples', -1, 0);
    await vi.advanceTimersByTimeAsync(180);
    expect(save).toHaveBeenCalledExactlyOnceWith('apples', 2);
  });

  it('rolls back a rejected quantity, keeps other items moving, and permits a fresh retry', async () => {
    const { queue, save, refresh, cart } = setup({ apples: 1 });
    save.mockRejectedValueOnce(new Error('Only one available'));
    queue.change('apples', 1, 10);
    queue.change('pears', 1, 10);
    await vi.advanceTimersByTimeAsync(180);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().errors.apples).toContain('Only one available');
    expect(queue.getSnapshot().pending).toEqual({});
    expect(cartQuantityCount(cart(), {})).toBe(2);
    queue.change('apples', 1, 10);
    expect(queue.getSnapshot().errors.apples).toBeUndefined();
    await vi.advanceTimersByTimeAsync(180);
    expect(cartQuantityCount(cart(), {})).toBe(3);
  });

  it('reconciles a lost response and uses absolute quantities for the next change', async () => {
    const { queue, save, refresh, cart } = setup();
    save.mockRejectedValueOnce(new Error('Network error'));
    refresh.mockResolvedValueOnce(makeCart({ apples: 1 }));
    queue.change('apples', 1, 10);
    await vi.advanceTimersByTimeAsync(180);
    expect(cartQuantityCount(cart(), {})).toBe(1);
    queue.change('apples', 1, 10);
    await vi.advanceTimersByTimeAsync(180);
    expect(save).toHaveBeenNthCalledWith(2, 'apples', 2);
  });

  it('does not skip a corrective write when both the write and recovery response were lost', async () => {
    const { queue, save, refresh } = setup();
    save.mockRejectedValueOnce(new Error('Network error'));
    refresh.mockRejectedValueOnce(new Error('Offline'));
    queue.change('apples', 1, 10);
    await vi.advanceTimersByTimeAsync(180);
    queue.change('apples', 1, 10);
    queue.change('apples', -1, 10);
    await vi.advanceTimersByTimeAsync(180);
    expect(save).toHaveBeenNthCalledWith(2, 'apples', 0);
  });

  it('ignores late responses and cancels queued work after the cart scope is disposed', async () => {
    const { queue, save, write, settled } = setup();
    const first = deferred<Cart>();
    save.mockReturnValueOnce(first.promise);
    queue.change('apples', 1, 10);
    await vi.advanceTimersByTimeAsync(180);
    queue.change('pears', 1, 10);
    queue.dispose();
    first.resolve(makeCart({ apples: 1 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it('accepts server corrections without repeatedly submitting the same quantity', async () => {
    const { queue, save, cart } = setup();
    save.mockResolvedValueOnce(makeCart({ apples: 1 }));
    queue.change('apples', 1, 10);
    queue.change('apples', 1, 10);
    await vi.advanceTimersByTimeAsync(180);
    expect(save).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().pending).toEqual({});
    expect(cartQuantityCount(cart(), {})).toBe(1);
  });
});
