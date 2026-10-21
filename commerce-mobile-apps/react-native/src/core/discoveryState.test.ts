import { describe, expect, it, vi } from 'vitest';
import { CatalogStore } from './catalogStore';
import { AssistantStore } from './assistantStore';
import { OperationCancelled } from './featureState';
import { CommerceError, type CommerceClient, type LiveProduct, type Locale, type Pin } from './commerce';
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const product = (id: string): LiveProduct => ({ id, name: id, description: '', price: '1', currency: 'USD', in_stock: true, product_type: 'simple', media_ids: [] });
const catalogClient = () => ({ locale: 'en' as Locale, pin: null as Pin | null, categories: vi.fn(async () => []), search: vi.fn<CommerceClient['search']>(async () => ({ hits: [product('a')], total: 1 })), product: vi.fn(async (id: string) => product(id)), family: vi.fn(async () => ({ children: [] as LiveProduct[] })) });
type Stream = CommerceClient['streamAssistant'];
const assistantClient = (streamAssistant: Stream) => { let id = 0; return { assistantID: () => `request-${++id}`, streamAssistant }; };
const options = () => ({ settled: vi.fn(async () => {}), checkout: vi.fn() });

describe('catalog store', () => {
  it('ignores old searches even when transport ignores cancellation', async () => {
    const c = catalogClient(), old = deferred<{ hits: LiveProduct[]; total: number }>();
    c.search.mockImplementationOnce(() => old.promise);
    const store = new CatalogStore(c), first = store.refresh('en');
    store.update({ query: 'new' }); await store.refresh('en');
    old.resolve({ hits: [product('old')], total: 99 }); await first;
    expect(store.getSnapshot().products.map(p => p.id)).toEqual(['a']); expect(store.getSnapshot().total).toBe(1);
  });
  it('advances by raw hits and deduplicates visible products', async () => {
    const c = catalogClient();
    c.search.mockResolvedValueOnce({ hits: [product('a'), { ...product('hidden'), active: false }], total: 4 });
    c.search.mockResolvedValueOnce({ hits: [product('a'), product('b')], total: 4 });
    const store = new CatalogStore(c); await store.refresh('en'); await store.refresh('en', true);
    expect(c.search.mock.calls[1]?.[2]).toBe(2);
    expect(store.getSnapshot().products.map(p => p.id)).toEqual(['a', 'b']); expect(store.getSnapshot().hasMore).toBe(false);
  });
  it('preserves rows on a failed next page and allows retry', async () => {
    const c = catalogClient(); c.search.mockResolvedValueOnce({ hits: [product('a')], total: 2 }).mockRejectedValueOnce(new Error('offline'));
    const store = new CatalogStore(c); await store.refresh('en'); await store.refresh('en', true);
    expect(store.getSnapshot().products).toHaveLength(1); expect(store.getSnapshot().offset).toBe(1); expect(store.getSnapshot().error).not.toBe('');
    c.search.mockResolvedValue({ hits: [product('b')], total: 2 }); await store.refresh('en', true); expect(store.getSnapshot().products).toHaveLength(2);
  });
  it('does not reopen dismissed products or attach late variants', async () => {
    const c = catalogClient(), gate = deferred<LiveProduct>(); c.product.mockImplementationOnce(() => gate.promise);
    const store = new CatalogStore(c), opening = store.openProduct('old'); store.dismissProduct(); gate.resolve(product('old'));
    await expect(opening).rejects.toBeInstanceOf(OperationCancelled); expect(store.getSnapshot().selected).toBeNull();
    c.pin = { latitude: 30, longitude: 31 }; const variants = deferred<{ children: LiveProduct[] }>();
    c.product.mockResolvedValueOnce({ ...product('parent'), product_type: 'configurable' }); c.family.mockImplementationOnce(() => variants.promise);
    const first = store.openProduct('parent'); await Promise.resolve(); await store.openProduct('new'); variants.resolve({ children: [product('variant')] });
    await expect(first).rejects.toBeInstanceOf(OperationCancelled); expect(store.getSnapshot().selected?.id).toBe('new'); expect(store.getSnapshot().variants).toEqual([]);
  });
});
describe('assistant store', () => {
  it('blocks duplicate sends and navigates only after successful settlement', async () => {
    const gate = deferred<void>(), settled = vi.fn(() => gate.promise), checkout = vi.fn();
    const stream = vi.fn<Stream>(async (input, event) => {
      event({ version: '1', request_id: input.request_id, sequence: 0, type: 'message.delta', text: 'Review', code: 'open_checkout', response_source: 'R' });
      event({ version: '1', request_id: input.request_id, sequence: 1, type: 'done' });
    });
    const store = new AssistantStore(assistantClient(stream)); const run = store.send('review', { settled, checkout }); await Promise.resolve();
    await store.send('duplicate', { settled, checkout }); expect(stream).toHaveBeenCalledTimes(1); expect(checkout).not.toHaveBeenCalled();
    gate.resolve(); await run; expect(checkout).toHaveBeenCalledTimes(1); expect(store.getSnapshot().busy).toBe(false);
  });
  it('discards late streaming events after account reset', async () => {
    const gate = deferred<void>(), callbacks = options();
    const store = new AssistantStore(assistantClient(async (input, event) => { await gate.promise; event({ version: '1', request_id: input.request_id, sequence: 0, type: 'message.delta', text: 'private' }); }));
    const run = store.send('hello', callbacks); store.reset(); gate.resolve(); await run;
    expect(store.getSnapshot().turns).toEqual([]); expect(callbacks.settled).not.toHaveBeenCalled(); expect(callbacks.checkout).not.toHaveBeenCalled();
  });
  it('settles stopped streams without replay or checkout navigation', async () => {
    const gate = deferred<void>(), callbacks = options();
    const stream = vi.fn<Stream>(async () => gate.promise), store = new AssistantStore(assistantClient(stream));
    const run = store.send('add', callbacks); store.stop(); gate.resolve(); await run;
    expect(store.getSnapshot().turns[0]?.interrupted).toBe(true); expect(callbacks.settled).toHaveBeenCalledTimes(1); expect(callbacks.checkout).not.toHaveBeenCalled(); expect(stream).toHaveBeenCalledTimes(1);
  });
  it('validates input and exposes authentication errors', async () => {
    const stream = vi.fn<Stream>(async () => { throw new CommerceError(401, 'Sign in'); });
    const store = new AssistantStore(assistantClient(stream)), callbacks = options();
    await store.send(' ', callbacks); await store.send('x'.repeat(4001), callbacks); expect(stream).not.toHaveBeenCalled();
    await store.send('hello', callbacks); expect(store.getSnapshot().signIn).toBe(true); expect(store.getSnapshot().turns[0]?.interrupted).toBe(true);
  });
});

describe('assistant proposal and product prompt stores', () => {
  it('checks an uncertain approval before allowing another mutation', async () => {
    const { AssistantProposalStore } = await import('./assistantProposalStore');
    const proposal = { can_apply: true, applied: false, expires_at: '2099-01-01T00:00:00Z', draft: {}, execution: {} };
    const fetch = vi.fn(async () => proposal), store = new AssistantProposalStore('id', { assistantProposal: fetch });
    const settled = vi.fn(async () => {}), apply = vi.fn(async () => { throw new Error('lost response'); });
    await store.reload(settled); await store.apply(apply, settled, false); await store.apply(apply, settled, false);
    expect(apply).toHaveBeenCalledTimes(1); expect(store.getSnapshot().pending).toBe(true); expect(store.getSnapshot().issue).toBe('unconfirmed');
    fetch.mockResolvedValue({ ...proposal, applied: true }); await store.reload(settled);
    expect(store.getSnapshot().pending).toBe(false); expect(store.canApply).toBe(false); expect(settled).toHaveBeenCalledTimes(1);
  });
  it('does not publish stale prompt results or keep obsolete comparison selections', async () => {
    const { ProductPromptStore } = await import('./productPromptStore');
    const store = new ProductPromptStore(), gate = deferred<LiveProduct[]>();
    const old = store.load(() => gate.promise); await store.load(async () => [product('new')]);
    store.select('new'); gate.resolve([product('old')]); await old;
    expect(store.getSnapshot().products[0]?.id).toBe('new'); expect(store.getSnapshot().selected).toEqual(['new']);
    await store.load(async () => [product('next')]); expect(store.getSnapshot().selected).toEqual([]);
  });
});
