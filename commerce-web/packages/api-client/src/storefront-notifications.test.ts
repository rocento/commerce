import { afterEach, expect, it, vi } from 'vitest';
import { notificationCampaignApi, notificationPublicationApi, safeNotificationPath, storefrontNotificationApi, type NotificationAudienceRules, type NotificationCampaignInput } from './storefront-notifications';

vi.mock('./identity', async (original) => ({
  ...await original<typeof import('./identity')>(),
  customerSessionHeaders: () => ({ 'Content-Type': 'application/json', 'X-Commerce-Request': '1', Authorization: 'Bearer current-session' }),
  withCustomerSession: <T>(operation: () => Promise<T>) => operation(),
}));
afterEach(() => vi.unstubAllGlobals());

function mockFetch() {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('uses the current customer session and browser cookie without accepting a recipient ID', async () => {
  const fetch = mockFetch();
  const signal = new AbortController().signal;
  await storefrontNotificationApi.list({ filter: 'unread', limit: 20, before: '2026-10-04T10:00:00+02:00', before_id: 'cursor/id' }, signal);
  expect(fetch).toHaveBeenCalledWith('/api/v1/notifications?filter=unread&limit=20&before=2026-10-04T10%3A00%3A00%2B02%3A00&before_id=cursor%2Fid', expect.objectContaining({
    credentials: 'include', cache: 'no-store', signal, headers: { 'x-delivery-context': '1', Authorization: 'Bearer current-session', 'Content-Type': 'application/json', 'X-Commerce-Request': '1' },
  }));
});

it('preserves the server snapshot cutoff, request marker and cancellation on read mutations', async () => {
  const fetch = mockFetch();
  const signal = new AbortController().signal;
  await storefrontNotificationApi.read('notice/id', { read: false }, signal);
  await storefrontNotificationApi.readAll({ through: '2026-10-04T10:00:00Z' }, signal);
  expect(fetch.mock.calls[0]).toEqual(['/api/v1/notifications/notice%2Fid/read', expect.objectContaining({
    method: 'PUT', signal, body: '{"read":false}',
    headers: { 'x-delivery-context': '1', Authorization: 'Bearer current-session', 'Content-Type': 'application/json', 'X-Commerce-Request': '1' },
  })]);
  expect(fetch.mock.calls[1]).toEqual(['/api/v1/notifications/read-all', expect.objectContaining({ method: 'POST', signal, body: '{"through":"2026-10-04T10:00:00Z"}' })]);
});

it('keeps customer content and recipients server-derived while retaining the publish retry key', async () => {
  const fetch = mockFetch();
  const input = { cta_label: 'Continue shopping', cta_path: '/cart', starts_at: null, expires_at: '2026-11-01T10:00:00Z', idempotency_key: 'same-retry-key' };
  await notificationPublicationApi.publishRecord('source/id', input);
  await notificationPublicationApi.publishRecord('source/id', input);
  expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]);
  expect(fetch.mock.calls[0]).toEqual(['/api/v1/admin/marketing/notifications/records/source%2Fid/publish', expect.objectContaining({
    method: 'POST', credentials: 'include', cache: 'no-store', body: JSON.stringify(input),
    headers: { 'Content-Type': 'application/json', 'X-Commerce-Request': '1' },
  })]);
});

it('publishes an explicit announcement audience and withdraws using its last known version', async () => {
  const fetch = mockFetch();
  const input = { title: 'Weekend news', body: 'Explore our latest products.', audience: 'guests' as const, area_ids: ['area-a', 'area-b'], cta_label: null, cta_path: null, starts_at: null, expires_at: '2026-11-01T10:00:00Z', idempotency_key: 'announcement-key' };
  await notificationPublicationApi.publishAnnouncement(input);
  await notificationPublicationApi.withdraw('notice/id', { version: 3 });
  await notificationPublicationApi.list({ offset: 0, limit: 25 });
  expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify(input));
  expect(fetch.mock.calls[1]).toEqual(['/api/v1/admin/marketing/notifications/publications/notice%2Fid/withdraw', expect.objectContaining({ body: '{"version":3}' })]);
  expect(fetch.mock.calls[2][0]).toBe('/api/v1/admin/marketing/notifications/publications?offset=0&limit=25');
});

it('persists campaign rules exactly and activates only the saved version with a stable retry key', async () => {
  const fetch = mockFetch();
  const rules: NotificationAudienceRules = {
    segment_ids: ['segment-1'], segment_match: 'all', trigger_kind: 'purchase',
    conditions: { match: 'all', rules: [{ field: 'order.total', operator: 'gte', value: '999999999999.99', currency: 'EGP' }] },
    delay_minutes: 60, lookback_days: 7, cooldown_hours: 24, max_deliveries: 2, suppress_after_purchase: false,
  };
  const input: NotificationCampaignInput = {
    name: 'Returning customers', description: 'A saved campaign draft', version: 0,
    announcement: { title: 'Thank you', body: 'Your next order awaits.', audience: 'customers', audience_rules: rules,
      cta_label: null, cta_path: null, starts_at: null, expires_at: '2026-11-01T10:00:00Z' },
  };
  await notificationCampaignApi.create(input);
  await notificationCampaignApi.update('campaign/id', { ...input, version: 4 });
  const activation = { version: 5, idempotency_key: 'stable-activation-key' };
  await notificationCampaignApi.activate('campaign/id', activation);
  await notificationCampaignApi.activate('campaign/id', activation);
  expect(fetch.mock.calls[0]).toEqual(['/api/v1/admin/marketing/notifications/campaigns', expect.objectContaining({
    method: 'POST', credentials: 'include', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Commerce-Request': '1' }, body: JSON.stringify(input),
  })]);
  expect(fetch.mock.calls[1]).toEqual(['/api/v1/admin/marketing/notifications/campaigns/campaign%2Fid', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ ...input, version: 4 }) })]);
  expect(fetch.mock.calls[2]).toEqual(['/api/v1/admin/marketing/notifications/campaigns/campaign%2Fid/activate', expect.objectContaining({ method: 'POST', body: JSON.stringify(activation) })]);
  expect(fetch.mock.calls[3]).toEqual(fetch.mock.calls[2]);
});

it('passes campaign list filters and cancellation through without dropping an offset of zero', async () => {
  const fetch = mockFetch();
  const signal = new AbortController().signal;
  await notificationCampaignApi.list({ offset: 0, limit: 20, search: 'A & B', status: 'draft' }, signal);
  await notificationCampaignApi.get('campaign/id', signal);
  expect(fetch.mock.calls[0]).toEqual(['/api/v1/admin/marketing/notifications/campaigns?offset=0&limit=20&search=A+%26+B&status=draft', expect.objectContaining({ signal, method: 'GET' })]);
  expect(fetch.mock.calls[1]).toEqual(['/api/v1/admin/marketing/notifications/campaigns/campaign%2Fid', expect.objectContaining({ signal, method: 'GET' })]);
});

it('preserves authentication and version failures without falling back to a public inbox', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response('{"error":"Session expired"}', { status: 401 }))
    .mockResolvedValueOnce(new Response('{"error":"Publication changed"}', { status: 409 }))
    .mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  await expect(storefrontNotificationApi.list()).rejects.toMatchObject({ status: 401, message: 'Session expired' });
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(notificationPublicationApi.withdraw('notice', { version: 1 })).rejects.toMatchObject({ status: 409, message: 'Publication changed' });
  await expect(storefrontNotificationApi.list()).rejects.toMatchObject({ status: 503, message: expect.stringContaining('Please try again') });
});

it.each(['/', '/search', '/cart', '/support', '/account', '/account/orders', '/products/fresh-milk', '/categories/أسماك', '/pages/about_us', '/account/orders/11223344-1234-1234-1234-112233445566'])('accepts supported storefront CTA %s', (path) => {
  expect(safeNotificationPath(path)).toBe(true);
});
it.each(['https://evil.example', '//evil.example', 'javascript:alert(1)', '/admin', '/products/..', '/products/%2e%2e', '/products/milk?next=evil', '/products/milk#x', '/products/a/b', '/products/a\\b', '/products/a\nb', '/account/orders/customer-id', `/products/${'x'.repeat(301)}`])('rejects unsafe or unsupported CTA %s', (path) => {
  expect(safeNotificationPath(path)).toBe(false);
});

it('includes delivery coordinates on every inbox request', async () => {
  const { setDeliveryPin } = await import('./delivery');
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  const fetch = mockFetch();
  setDeliveryPin({ latitude: 30.04, longitude: 31.23 });
  try {
    await storefrontNotificationApi.list();
    await storefrontNotificationApi.read('notice', { read: true });
    await storefrontNotificationApi.readAll({ through: '2026-10-04T10:00:00Z' });
    for (const [, input] of fetch.mock.calls) expect(input.headers).toMatchObject({
      'x-delivery-latitude': '30.04', 'x-delivery-longitude': '31.23',
    });
  } finally { setDeliveryPin(null); }
});

it('reports product visits with session, cookie and CSRF marker and no caller-controlled recipient', async () => {
  const fetch = mockFetch();
  const signal = new AbortController().signal;
  await storefrontNotificationApi.productView('tomatoes', signal);
  expect(fetch).toHaveBeenCalledWith('/api/v1/notifications/product-view', expect.objectContaining({
    method: 'POST', credentials: 'include', cache: 'no-store', signal,
    body: '{"product":"tomatoes"}',
    headers: expect.objectContaining({ Authorization: 'Bearer current-session', 'X-Commerce-Request': '1' }),
  }));
});

 it('deletes using the current version and sends search filters to the server', async () => {
  const fetch = mockFetch();
  await notificationPublicationApi.delete('notice/id', { version: 4 });
  expect(fetch.mock.calls[0]).toEqual(['/api/v1/admin/marketing/notifications/publications/notice%2Fid', expect.objectContaining({ method: 'DELETE', body: '{"version":4}', headers: { 'Content-Type': 'application/json', 'X-Commerce-Request': '1' } })]);
  await notificationPublicationApi.list({ offset: 10, limit: 10, search: 'summer & sale', status: 'live' });
  expect(fetch.mock.calls[1][0]).toBe('/api/v1/admin/marketing/notifications/publications?offset=10&limit=10&search=summer+%26+sale&status=live');
});

 it('sends one JSON content type on product visits and every read mutation', async () => {
  const fetch = mockFetch();
  await storefrontNotificationApi.productView('tomatoes');
  await storefrontNotificationApi.read('first', { read: true });
  await storefrontNotificationApi.read('second', { read: true });
  await storefrontNotificationApi.readAll({ through: '2026-10-05T00:00:00Z' });
  for (const [path, input] of fetch.mock.calls) {
    const request = new Request('https://store.example' + path, input);
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('authorization')).toBe('Bearer current-session');
  }
});
