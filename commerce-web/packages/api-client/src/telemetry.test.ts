import { afterEach, expect, test, vi } from 'vitest';
vi.mock('./delivery', () => ({ deliveryHeaders: () => ({ 'X-Delivery-Test': 'selected-location' }) }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock('./telemetry-tracer'); });

test('disabled telemetry makes one request and preserves same-origin delivery context', async () => {
  
  vi.stubGlobal('location', new URL('https://shop.example.test/'));
  const fetcher = vi.fn().mockResolvedValue(new Response('ok'));
  vi.stubGlobal('fetch', fetcher);
  const { createTraceFetch } = await import('./telemetry');
  const traceFetch = createTraceFetch();
  await traceFetch('https://shop.example.test/api/v1/cart', { method:'POST', body:'basket' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const request = fetcher.mock.calls[0][0] as Request;
  expect(request.headers.get('X-Delivery-Test')).toBe('selected-location');
  expect(await request.text()).toBe('basket');
  await traceFetch('https://other.example.test/api/v1/cart');
  expect(fetcher.mock.calls[1][0].headers.get('X-Delivery-Test')).toBeNull();
});

test('enabled telemetry initializes once across simultaneous requests', async () => {
  
  vi.stubGlobal('location', new URL('https://shop.example.test/'));
  const traced = vi.fn().mockResolvedValue(new Response('ok'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('fallback')));
  const create = vi.fn(() => traced);
  vi.doMock('./telemetry-tracer', () => ({ createTracedFetch: create }));
  const { createTraceFetch } = await import('./telemetry');
  const traceFetch = createTraceFetch('https://shop.example.test/traces');
  await Promise.all([traceFetch('https://shop.example.test/api/v1/cart'), traceFetch('https://shop.example.test/api/v1/catalog')]);
  expect(create).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith('https://shop.example.test/traces');
  expect(traced).toHaveBeenCalledTimes(2);
});

test('unavailable telemetry falls back, but a failed shopping write is never replayed', async () => {
  
  vi.stubGlobal('location', new URL('https://shop.example.test/'));
  const fetcher = vi.fn().mockRejectedValue(new Error('Network unavailable'));
  vi.stubGlobal('fetch', fetcher);
  vi.doMock('./telemetry-tracer', () => { throw new Error('Chunk unavailable'); });
  const { createTraceFetch } = await import('./telemetry');
  const traceFetch = createTraceFetch('/traces');
  await expect(traceFetch('https://shop.example.test/api/v1/cart', { method:'POST' })).rejects.toThrow('Network unavailable');
  expect(fetcher).toHaveBeenCalledOnce();
});
