import { describe, expect, it } from 'vitest';
import fixture from '../../../shared/testing/commerce-flow.json';
import { OrderStore } from './orderStore';
import { NavigationStore } from './navigationStore';
import { OperationCancelled } from './featureState';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const detail = (id: string) => ({ ...fixture.detail, order: { ...fixture.order, id } });
describe('order history and details', () => {
  it('uses raw page offsets despite duplicates and stops at an empty page', async () => {
    const offsets: number[] = [];
    const store = new OrderStore({ orders: async offset => { offsets.push(offset!); return offset === 0 ? [fixture.order, fixture.order] : []; }, order: async id => detail(id) });
    await store.refresh(); await store.refresh(true); await store.refresh(true);
    expect(offsets).toEqual([0, 2]); expect(store.getSnapshot().orders).toHaveLength(1); expect(store.getSnapshot().hasMore).toBe(false);
  });
  it('retains history on failure and allows retry', async () => {
    let fail = false;
    const store = new OrderStore({ orders: async () => { if (fail) throw Error('offline'); return [fixture.order]; }, order: async id => detail(id) });
    await store.refresh(); fail = true; await expect(store.refresh()).rejects.toThrow('offline');
    expect(store.getSnapshot()).toMatchObject({ failed: true, loading: false, orders: [fixture.order] });
    fail = false; await store.refresh(); expect(store.getSnapshot().failed).toBe(false);
  });
  it('prevents older detail requests overwriting a new selection or checkout result', async () => {
    const response = deferred<ReturnType<typeof detail>>();
    const store = new OrderStore({ orders: async () => [], order: async id => id === 'old' ? response.promise : detail(id) });
    const pending = store.track('old'); await store.track('new'); response.resolve(detail('old'));
    await expect(pending).rejects.toBeInstanceOf(OperationCancelled); expect(store.getSnapshot().detail?.order.id).toBe('new');
    const next = store.track('old'); store.show(detail('checkout'));
    await expect(next).rejects.toBeInstanceOf(OperationCancelled); expect(store.getSnapshot().detail?.order.id).toBe('checkout');
  });
  it('reset cancels a late history read and detail selection clears old content on failure', async () => {
    const response = deferred<typeof fixture.order[]>();
    const store = new OrderStore({ orders: () => response.promise, order: async () => { throw Error('offline'); } });
    const pending = store.refresh(); store.reset(); response.resolve([fixture.order]);
    await expect(pending).rejects.toBeInstanceOf(OperationCancelled); expect(store.getSnapshot().orders).toEqual([]);
    store.show(detail('old')); await expect(store.track('new')).rejects.toThrow();
    expect(store.getSnapshot()).toMatchObject({ detail: null, selectedID: 'new', detailFailed: true, detailLoading: false });
  });
});
describe('navigation', () => {
  it('returns to the order entry point and dismisses checkout before leaving the tab', () => {
    const nav = new NavigationStore(); nav.selectTab('account'); nav.open('notifications'); nav.open('order'); nav.back();
    expect(nav.getSnapshot().panel).toBe('notifications'); nav.back(); expect(nav.getSnapshot().panel).toBeNull();
    nav.selectTab('bag'); nav.presentCheckout(true); nav.back(); expect(nav.getSnapshot()).toEqual({ tab: 'bag', panel: null, checkout: false });
    nav.back(); expect(nav.getSnapshot().tab).toBe('home'); expect(nav.back()).toBe(false);
  });
  it('clears customer destinations on identity change and tab selection', () => {
    const nav = new NavigationStore(); nav.selectTab('account'); nav.open('orders'); nav.open('order'); nav.resetCustomerRoutes();
    expect(nav.getSnapshot()).toEqual({ tab: 'account', panel: null, checkout: false });
    nav.open('auth'); nav.selectTab('catalog'); expect(nav.getSnapshot().panel).toBeNull();
  });
});
