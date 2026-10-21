import invalid from '../../../shared/testing/invalid-commerce.json';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../shared/testing/commerce-flow.json';
import { CommerceClient, imageURL, merchant, validPin, type LiveProduct, type Quote, type Transport } from './commerce';

const customer = { id: '70000000-0000-0000-0000-000000000001', email: 'fixture@example.test', verified: true };
const product: LiveProduct = { id: '70000000-0000-0000-0000-000000000002', name: 'Apples', description: '', price: '3.50', currency: 'USD', in_stock: true, product_type: 'simple' };
const quote = fixture.quote as Quote;
const response = (data: unknown, status = 200, refresh = false) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: refresh ? { 'set-cookie': `customer_refresh=${'r'.repeat(64)}; HttpOnly; Secure; Path=/api` } : {} });
const auth = () => response({ customer, access_token: 'fixture-access' }, 200, true);
function setup(handler: Transport) {
  const values = new Map<string, string>();
  const storage = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string | null) => { if (value === null) values.delete(key); else values.set(key, value); } };
  const transport = vi.fn(handler);
  const client = new CommerceClient(transport, storage, () => '70000000-0000-0000-0000-000000000099');
  return { client, transport, storage, values };
}
describe('live commerce contract', () => {
  it('supports native buffered Response objects without losing their body or byte limit', async () => {
    const buffered = (text: string) => ({ body: null, text: async () => text, ok: true, status: 200, headers: new Headers() }) as Response;
    const valid = setup(async () => buffered(JSON.stringify({ hits: [product], total: 1 }))).client;
    expect((await valid.search()).hits[0]?.id).toBe(product.id);
    const oversized = setup(async () => buffered('ع'.repeat(1_000_001))).client;
    await expect(oversized.search()).rejects.toThrow('Response exceeds supported size');
  });

  it('rejects shared malformed responses before persisting or exposing feature state', async () => {
    const { client, storage } = setup(async () => response(invalid.malformed_auth, 200, true));
    const writes = vi.spyOn(storage, 'set');
    await expect(client.login('fixture', 'password')).rejects.toThrow('Invalid server response');
    expect(client.customer).toBeNull();
    expect(writes.mock.calls.every(([, value]) => value === null)).toBe(true);
    const cartClient = setup(async () => response(invalid.malformed_cart)).client;
    await expect(cartClient.request('v1/cart', 'POST', undefined, false)).rejects.toThrow('Invalid server response');
    const quoteClient = setup(async () => response(invalid.malformed_quote)).client;
    await expect(quoteClient.request('v1/customer/checkout/quote', 'POST', undefined, false)).rejects.toThrow('Invalid server response');
  });
  it('retains malformed persisted attempts and never sends a replacement order', async () => {
    const { client, values, transport } = setup(async () => auth());
    await client.login('fixture', 'password');
    const key = `rocento.rn.v1.production.${merchant.id}.checkout.${customer.id}`;
    for (const saved of ['{broken', JSON.stringify({ customerID: 'another-owner', quote, key: 'previous' })]) {
      values.set(key, saved);
      await expect(client.place(quote)).rejects.toThrow('Saved checkout');
      expect(values.get(key)).toBe(saved);
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized UTF-8 body while streaming and cancels the reader', async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode('ع'.repeat(600_000));
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunk++ < 3) controller.enqueue(bytes);
        else controller.close();
      },
      cancel,
    });
    const { client } = setup(async () => new Response(body));
    await expect(client.search('', '', 0)).rejects.toThrow('Response exceeds supported size');
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it('decodes JSON when a multibyte character spans response chunks', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ hits: [{ ...product, name: 'تفاح' }], total: 1 }));
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index));
        else controller.close();
      },
    });
    const { client } = setup(async () => new Response(body));
    expect((await client.search('', '', 0)).hits[0]?.name).toBe('تفاح');
    expect(body.locked).toBe(false);
  });
  it('applies and removes coupons with the authenticated cart contract', async () => {
    const { client, transport } = setup(async (url, init) => url.endsWith('/login') ? auth() : response({ ...fixture.cart, coupon_code: JSON.parse(init.body as string).code || null }));
    await client.login('fixture@example.test', 'password');
    expect((await client.coupon('  SAVE5  ')).coupon_code).toBe('SAVE5');
    expect((await client.coupon('')).coupon_code).toBeNull();
    for (const [url, init] of transport.mock.calls.slice(1)) {
      expect(url).toBe(merchant.origin + '/v1/cart/coupon'); expect(init.method).toBe('PUT');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-access' });
    }
    expect(transport.mock.calls.some(([url]) => url.endsWith('/place'))).toBe(false);
  });
  it('uses only the compiled merchant origin and localizes guest catalog without credentials', async () => {
    const { client, transport } = setup(async () => response({ hits: [product], total: 1 }));
    client.locale = 'ar';
    await client.search('تفاح & apple', '', 24);
    const [url, init] = transport.mock.calls[0]!;
    expect(url.startsWith(merchant.origin + '/v1/search?')).toBe(true);
    expect(new URL(url).searchParams.get('q')).toBe('تفاح & apple');
    expect(new URL(url).searchParams.get('offset')).toBe('24');
    expect(init.headers).toMatchObject({ 'X-Storefront-Locale': 'ar', 'X-Commerce-Request': '1' });
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.headers).not.toHaveProperty('X-Delivery-Context');
    expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error');
    await expect(client.request('https://other.test/v1/cart')).rejects.toThrow('Invalid request');
  });
  it('saves only the refresh credential and restores after a new client instance', async () => {
    const { client, storage, values, transport } = setup(async () => auth());
    await client.login('fixture@example.test', 'fixture-password');
    expect([...values.values()]).toEqual(['r'.repeat(64)]);
    const restarted = new CommerceClient(transport, storage, () => 'unused');
    expect(await restarted.restore()).toEqual(customer);
    expect(transport.mock.calls[1]![1].headers).toMatchObject({ Cookie: `customer_refresh=${'r'.repeat(64)}` });
  });
  it('coalesces refresh and retries one unauthorized request with the bearer', async () => {
    let refreshes = 0, cartCalls = 0;
    const { client } = setup(async url => {
      if (url.endsWith('/refresh')) { refreshes++; await new Promise(resolve => setTimeout(resolve, 10)); return auth(); }
      if (url.endsWith('/cart')) { cartCalls++; return cartCalls <= 2 ? response({ error: 'Expired' }, 401) : response(fixture.cart); }
      return auth();
    });
    await client.login('fixture@example.test', 'password');
    await Promise.all([client.cart(), client.cart()]);
    expect(refreshes).toBe(1); expect(cartCalls).toBe(4);
  });
  it('a delayed refresh cannot restore a logged-out session', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const { client, values } = setup(async url => url.endsWith('/refresh') ? pending : auth());
    await client.login('fixture@example.test', 'password');
    const restoring = client.restore();
    await Promise.resolve(); await Promise.resolve();
    await client.logout(); finish(auth());
    await expect(restoring).rejects.toThrow('Session changed');
    expect(client.customer).toBeNull(); expect(values.size).toBe(0);
  });
  it('retains refresh credentials on network errors and removes revoked credentials', async () => {
    let revoked = false;
    const { client, values } = setup(async url => {
      if (url.endsWith('/refresh')) { if (revoked) return response({ error: 'Revoked' }, 401); throw new Error('offline'); }
      return auth();
    });
    await client.login('fixture@example.test', 'password');
    await expect(client.restore()).rejects.toThrow('offline'); expect(values.size).toBe(1);
    revoked = true; await expect(client.restore()).rejects.toThrow('Revoked'); expect(values.size).toBe(0);
  });
  it('checks product availability and requires a concrete variant before adding', async () => {
    let configurable = true;
    const { client, transport } = setup(async url => url.includes('/products/') ? response({ ...product, product_type: configurable ? 'configurable' : 'simple' }) : url.endsWith('/login') ? auth() : response(fixture.cart));
    await client.login('fixture@example.test', 'password');
    client.pin = { latitude: 30, longitude: 31 };
    await expect(client.add(product)).rejects.toThrow('Choose an available');
    expect(transport.mock.calls.some(([url]) => url.endsWith('/cart/items'))).toBe(false);
    configurable = false; await client.add(product, 3);
    const [, init] = transport.mock.calls.at(-1)!;
    expect(JSON.parse(init.body as string)).toEqual({ product_id: product.id, quantity: 3 });
    transport.mockClear();
    for (const quantity of [0, -1, 1.5, 100, Infinity]) await expect(client.add(product, quantity)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('uses coverage headers and rejects invalid pins and quantities', async () => {
    const { client, transport } = setup(async () => response({ configured: true, deliverable: true }));
    client.pin = { latitude: 30.0444, longitude: 31.2357 }; await client.coverage();
    expect(transport.mock.calls[0]![1].headers).toMatchObject({ 'X-Delivery-Latitude': '30.0444', 'X-Delivery-Longitude': '31.2357' });
    expect(validPin({ latitude: NaN, longitude: 0 })).toBe(false);
    expect(() => client.quantity(product.id, 0.5)).toThrow('Invalid quantity');
  });
  it('reserves fulfillment before obtaining the server quote and does not place it', async () => {
    const { client, transport } = setup(async url => url.endsWith('/login') ? auth() : url.endsWith('/quote') ? response(quote) : response({}));
    await client.login('fixture@example.test', 'password');
    const request = { method: 'delivery', location_id: product.id, source_id: null, date: '2026-10-12', asap: true };
    expect(await client.quote(request, [], 'Happy birthday')).toEqual(quote);
    expect(transport.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/v1/customer/auth/login', '/api/v1/fulfillment/plans', '/api/v1/customer/checkout/quote']);
    expect(JSON.parse(transport.mock.calls.at(-1)![1].body as string).gift_message).toBe('Happy birthday');
    await expect(client.quote(request, [], 'ع'.repeat(251))).rejects.toThrow('shorten');
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('persists the order key before sending and recovers uncertainty after restart', async () => {
    let fail = true;
    const { client, values, transport, storage } = setup(async url => {
      if (url.endsWith('/place')) {
        expect([...values.keys()].some(key => key.includes('.checkout.'))).toBe(true);
        if (fail) throw new Error('connection lost');
        return response(fixture.detail);
      }
      return auth();
    });
    await client.login('fixture@example.test', 'password');
    await expect(client.place(quote)).rejects.toThrow('connection lost');
    await client.logout();
    expect([...values.keys()].some(key => key.includes('.checkout.'))).toBe(true);
    const restarted = new CommerceClient(transport, storage, () => 'must-not-use-a-new-key');
    await restarted.login('fixture@example.test', 'password');
    expect((await restarted.pending())?.quote.id).toBe(quote.id);
    fail = false; await restarted.place(quote);
    const attempts = transport.mock.calls.filter(([url]) => url.endsWith('/place')).map(([, init]) => JSON.parse(init.body as string));
    expect(attempts[0]).toEqual(attempts[1]); expect(await restarted.pending()).toBeNull();
  });
  it('coalesces repeated place presses and only clears definite server rejection', async () => {
    const { client, transport } = setup(async url => url.endsWith('/place') ? response({ error: 'Quote expired' }, 400) : auth());
    await client.login('fixture@example.test', 'password');
    await Promise.allSettled([client.place(quote), client.place(quote)]);
    expect(transport.mock.calls.filter(([url]) => url.endsWith('/place'))).toHaveLength(1);
    expect(await client.pending()).toBeNull();
  });
  it('refuses login if secure storage fails and never pretends the session is saved', async () => {
    const client = new CommerceClient(async () => auth(), { get: async () => null, set: async (_, value) => { if (value) throw new Error('Keychain inaccessible'); } }, () => 'unused');
    await expect(client.login('fixture@example.test', 'password')).rejects.toThrow('Keychain inaccessible');
    expect(client.customer).toBeNull();
  });
  it('uses public image URLs with allowlisted media identifiers', () => {
    expect(imageURL({ ...product, media_ids: [product.id] })).toBe(`${merchant.origin}/v1/catalog/media/${product.id}/content?width=480`);
    expect(imageURL({ ...product, media_ids: ['https://other.test/image'] })).toBeUndefined();
  });
});

it('resolves section collections by slug without sending customer credentials', async () => {
  const id = '70000000-0000-0000-0000-000000000002';
  const { client, transport } = setup(async url => response(url.includes('/categories') ? [{ id, slug: 'fruit', name: 'Fruit' }] : { hits: [product], total: 1 }));
  expect(await client.designCollection('fruit')).toEqual([product]);
  expect(new URL(transport.mock.calls[1]![0]).searchParams.get('category_id')).toBe(id);
  expect(transport.mock.calls[1]![1].headers).not.toHaveProperty('Authorization');
});
it('resolves enabled storefront collection feeds and rejects unavailable feeds', async () => {
  const { client, transport } = setup(async url => response(url.includes('/theme/storefront') ? { configuration: { pages: { home: [{ id: 'fresh', enabled: true, component: 'product_collection', settings: { query: 'milk', limit: 1 } }] } } } : { hits: [product, product], total: 2 }));
  expect(await client.designCollection('demo-feed-fresh')).toEqual([product]);
  expect(new URL(transport.mock.calls[1]![0]).searchParams.get('q')).toBe('milk');
  await expect(client.designCollection('demo-feed-unknown')).rejects.toThrow('Collection unavailable');
});
