import { describe, expect, it } from 'vitest';
import { AssistantDecoder, consume, emptyReply, followupProduct } from './assistant';
import { CommerceClient, displayPrice, type LiveProduct, type Transport } from './commerce';
import fixture from '../testing/commerce-flow.json';
const id = '80000000-0000-4000-8000-000000000001', product = fixture.variant as LiveProduct;
const event = (sequence: number, type: string, rest = {}) => ({ version: '1', request_id: id, sequence, type, ...rest });
const encode = (events: unknown[]) => new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
const setup = (transport: Transport) => new CommerceClient(transport, { get: async () => null, set: async () => {} }, () => id);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const auth = () => new Response(JSON.stringify({ customer: fixture.customer, access_token: 'fixture-token' }), { headers: { 'set-cookie': `customer_refresh=${'f'.repeat(64)}; Secure` } });
describe('discovery commerce', () => {
  it('shows savings only for a matching, lower, nonnegative catalog offer', () => {
    const offer = { product_id: product.id, currency: product.currency, original_price: product.price, discounted_price: '20.00' };
    expect(displayPrice({ ...product, catalog_offer: offer })).toBe('20.00');
    for (const patch of [{ product_id: id }, { currency: 'USD' }, { original_price: '26' }, { discounted_price: '-1' }, { discounted_price: '25' }, { discounted_price: 'NaN' }]) expect(displayPrice({ ...product, catalog_offer: { ...offer, ...patch } })).toBe(product.price);
  });
  it('authenticates saves and never deletes a cart line if saving fails', async () => {
    const calls: string[] = [];
    const client = setup(async (url, init) => { if (url.endsWith('/login')) return auth(); calls.push(url); expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token'); return json({ error: 'Unable to save' }, 503); });
    await client.login('fixture@example.test', 'fixture'); await expect(client.saveForLater(product.id)).rejects.toThrow('Unable to save');
    expect(calls).toHaveLength(1); expect(calls[0]).toContain('/customer/wishlist/');
  });
  it('saves before removing and preserves proposal idempotency', async () => {
    const calls: { method?: string; body?: unknown }[] = [];
    const client = setup(async (url, init) => { if (url.endsWith('/login')) return auth(); calls.push({ method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined }); return json(fixture.cart); });
    await client.login('fixture@example.test', 'fixture'); await client.saveForLater(product.id); expect(calls.map(c => c.method)).toEqual(['PUT', 'DELETE']);
    await client.applyAssistantProposal(id); expect(calls[2]?.body).toEqual({ proposal_id: id, idempotency_key: id, grant_id: null }); expect(calls[3]?.body).toEqual({ idempotency_key: id });
  });
  it('rejects invalid wishlist identifiers', async () => {
    const client = setup(async url => url.endsWith('/login') ? auth() : json(['https://untrusted.test'])); await client.login('fixture@example.test', 'fixture'); await expect(client.wishlist()).rejects.toThrow('Invalid saved products');
  });
});
describe('assistant SSE', () => {
  it('decodes Arabic across individual bytes and CRLF', () => {
    const parser = new AssistantDecoder(id), events = [];
    for (const byte of encode([event(0, 'progress', { stage: 'catalog' }), event(1, 'message.delta', { text: 'تفاح طازج' }), event(2, 'done')])) events.push(...parser.feed(new Uint8Array([byte])));
    parser.finish(); expect(events[1]?.text).toBe('تفاح طازج'); expect(parser.done).toBe(true);
  });
  it('rejects reordered, cross-request, malformed and oversized streams', () => {
    for (const value of [event(1, 'done'), { ...event(0, 'done'), request_id: product.id }, event(0, 'progress', { stage: 'execute' }), event(0, 'content.blocks', { blocks: [{ kind: 'action', action: { route: 'https://untrusted.test' } }] })]) expect(() => new AssistantDecoder(id).feed(encode([value]))).toThrow();
    expect(() => new AssistantDecoder(id).feed(new Uint8Array(65537))).toThrow(); expect(() => new AssistantDecoder(id).finish()).toThrow('interrupted');
  });
  it('requires grounded products and valid comparison widths', () => {
    const p = { id: product.id, name: product.name, price: product.price, currency: product.currency, route: `/products/${product.id}`, reasons: [], unmet: [], attributes: [] };
    const block = { kind: 'product_card', products: [p], sources: [{ kind: 'catalog', product_id: p.id, route: p.route }] };
    expect(new AssistantDecoder(id).feed(encode([event(0, 'content.blocks', { blocks: [block] }), event(1, 'done')]))).toHaveLength(2);
    for (const invalid of [{ ...block, sources: [] }, { ...block, kind: 'comparison_table', rows: [{ label: 'Price', values: [] }] }]) expect(() => new AssistantDecoder(id).feed(encode([event(0, 'content.blocks', { blocks: [invalid] })]))).toThrow();
  });
  it('never opens checkout from failed or incomplete replies', () => {
    let reply = consume(emptyReply(), { ...event(0, 'message.delta'), text: 'Review checkout', code: 'open_checkout', response_source: 'R' }); expect(reply.completed).toBe(false);
    reply = consume(consume(reply, event(1, 'error', { text: 'Failed' })), event(2, 'done')); expect(reply.completed && !reply.failed && reply.checkoutRequested).toBe(false);
    expect(() => new AssistantDecoder(id).feed(encode([event(0, 'message.delta', { text: 'Checkout', code: 'open_checkout', response_source: 'unknown' })]))).toThrow();
  });
  it('limits followups to unambiguous product references', () => {
    const reply = { ...emptyReply(), blocks: [{ kind: 'product_card', products: [{ ...product, route: `/products/${product.id}`, reasons: [], unmet: [], attributes: [] }] }] };
    expect(followupProduct(reply, 'is it in stock?')).toBe(product.id); expect(followupProduct(reply, 'show me bread')).toBeUndefined();
  });
  it('streams guest replies with locale and pin but no token', async () => {
    const client = setup(async (url, init) => { expect(url).toMatch(/\/v1\/assistant\/chat$/); const h = new Headers(init.headers); expect(h.get('authorization')).toBeNull(); expect(h.get('x-storefront-locale')).toBe('ar'); expect(h.get('x-delivery-latitude')).toBe('30'); return new Response(encode([event(0, 'message.delta', { text: 'مرحباً' }), event(1, 'done')]), { headers: { 'content-type': 'text/event-stream' } }); });
    client.locale = 'ar'; client.pin = { latitude: 30, longitude: 31 }; const received: string[] = [];
    await client.streamAssistant({ request_id: id, conversation_id: id, message: 'تفاح' }, e => received.push(e.type), new AbortController().signal); expect(received).toEqual(['message.delta', 'done']);
  });
  it('does not replay partially received turns', async () => {
    let calls = 0; const received = emptyReply(); const client = setup(async () => { calls++; return new Response(encode([event(0, 'message.delta', { text: 'Review checkout', code: 'open_checkout', response_source: 'R' })]), { headers: { 'content-type': 'text/event-stream' } }); });
    await expect(client.streamAssistant({ request_id: id, conversation_id: id, message: 'checkout' }, e => Object.assign(received, consume(received, e)), new AbortController().signal)).rejects.toThrow('interrupted'); expect(calls).toBe(1); expect(received.completed).toBe(false);
  });
  it('stops delivering events after cancellation', async () => {
    const abort = new AbortController(), received: string[] = []; const client = setup(async () => new Response(encode([event(0, 'message.delta', { text: 'Hello' }), event(1, 'done')]), { headers: { 'content-type': 'text/event-stream' } }));
    await expect(client.streamAssistant({ request_id: id, conversation_id: id, message: 'help' }, e => { received.push(e.type); abort.abort(); }, abort.signal)).rejects.toThrow('stopped'); expect(received).toEqual(['message.delta']);
  });
});
