import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../shared/testing/commerce-flow.json';
import { CheckoutFlow } from './checkout';
import type { DeliveryRequest, Options, OrderDetail, Quote } from './commerce';

const quote = fixture.quote as Quote;
const detail = fixture.detail as OrderDetail;
const request: DeliveryRequest = { method: 'delivery', location_id: fixture.ids.location, source_id: null, date: '2026-10-13', asap: true };
const setup = () => {
  const client = {
    options: vi.fn(async () => fixture.options as Options),
    quote: vi.fn(async () => quote),
    place: vi.fn(async (_quote: Quote) => detail),
    pending: vi.fn(async (): Promise<{ quote: Quote; customerID: string; key: string } | null> => null),
  };
  return { client, flow: new CheckoutFlow(client) };
};
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('checkout lifecycle', () => {
  it('keeps gift drafts across delivery refresh, invalidates edits, enforces UTF-8 limits and clears on reset', async () => {
    const { flow, client } = setup();
    flow.setGiftMessage('هدية'); await flow.findOptions(request); await flow.review(request);
    expect(client.quote).toHaveBeenLastCalledWith(request, [], 'هدية');
    flow.setGiftMessage('For you'); expect(flow.getSnapshot().quote).toBeNull();
    flow.invalidate(); expect(flow.getSnapshot().giftMessage).toBe('For you');
    flow.setGiftMessage('ع'.repeat(251));
    await expect(flow.review(request)).rejects.toThrow('shorten'); expect(client.quote).toHaveBeenCalledTimes(1);
    flow.setGiftMessage('ع'.repeat(250)); expect(flow.giftMessageValid).toBe(true);
    const saved = { ...quote, snapshot: { ...quote.snapshot, gift_message: 'Saved gift' } };
    flow.restore(saved); flow.setGiftMessage('changed'); expect(flow.getSnapshot().giftMessage).toBe('Saved gift');
    flow.reset(); expect(flow.getSnapshot().giftMessage).toBe('');
  });
  it('loads options and reviews without placing, then invalidates a stale quote', async () => {
    const { flow, client } = setup();
    await flow.findOptions(request); await flow.review(request);
    expect(flow.getSnapshot().phase).toBe('ready'); expect(client.place).not.toHaveBeenCalled();
    flow.invalidate(); expect(flow.getSnapshot()).toMatchObject({ phase: 'editing', quote: null, options: null });
  });
  it('rejects duplicate confirmation before the first response and remains completed', async () => {
    const { flow, client } = setup(); const response = deferred<OrderDetail>();
    client.place.mockImplementation(() => response.promise);
    await flow.review(request); const first = flow.place();
    expect(flow.getSnapshot().phase).toBe('submitting');
    await expect(flow.place()).rejects.toThrow('Review your checkout');
    flow.invalidate(); expect(flow.locked).toBe(true);
    response.resolve(detail); await first;
    expect(client.place).toHaveBeenCalledTimes(1); expect(flow.getSnapshot().phase).toBe('completed');
    await expect(flow.place()).rejects.toThrow();
  });
  it('retains an unresolved quote and retries the same quote only on explicit confirmation', async () => {
    const { flow, client } = setup();
    client.place.mockRejectedValueOnce(new Error('response lost'));
    client.pending.mockResolvedValue({ quote, customerID: fixture.ids.customer, key: 'existing-key' });
    await flow.review(request); await expect(flow.place()).rejects.toThrow('response lost');
    flow.invalidate(); flow.edit(); expect(flow.getSnapshot()).toMatchObject({ phase: 'uncertain', quote });
    await expect(flow.review(request)).rejects.toThrow('already in progress');
    await flow.place(); expect(client.place.mock.calls.map(args => args[0])).toEqual([quote, quote]);
  });
  it('keeps recovery locked if pending storage fails', async () => {
    const { flow, client } = setup();
    client.place.mockRejectedValue(new Error('offline')); client.pending.mockRejectedValue(new Error('storage unavailable'));
    await flow.review(request); await expect(flow.place()).rejects.toThrow('offline');
    expect(flow.getSnapshot()).toMatchObject({ phase: 'uncertain', quote });
  });
  it('returns to editing after a definitive rejection without a pending attempt', async () => {
    const { flow, client } = setup(); client.place.mockRejectedValue(new Error('expired'));
    await flow.review(request); await expect(flow.place()).rejects.toThrow('expired');
    expect(flow.getSnapshot()).toMatchObject({ phase: 'editing', quote: null });
  });
  it('discards a quote response after a customer reset', async () => {
    const { flow, client } = setup(); const response = deferred<Quote>(); client.quote.mockImplementation(() => response.promise);
    const review = flow.review(request); flow.reset(); response.resolve(quote);
    await expect(review).rejects.toThrow('session changed'); expect(flow.getSnapshot().quote).toBeNull();
  });
  it('does not restore a previous customer pending attempt after reset during submission', async () => {
    const { flow, client } = setup(); const response = deferred<OrderDetail>(); client.place.mockImplementation(() => response.promise);
    await flow.review(request); const submission = flow.place(); flow.reset(); response.resolve(detail);
    await expect(submission).rejects.toThrow('session changed'); expect(client.pending).not.toHaveBeenCalled();
    expect(flow.getSnapshot().phase).toBe('editing');
  });
  it('restores an interrupted checkout without sending an order', () => {
    const { flow, client } = setup(); flow.restore(quote);
    expect(flow.locked).toBe(true); expect(client.place).not.toHaveBeenCalled();
  });
});
