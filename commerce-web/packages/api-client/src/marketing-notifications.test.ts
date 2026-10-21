import { afterEach, expect, it, vi } from 'vitest';
import { marketingNotificationApi, type NotificationProgramInput } from './marketing-notifications';

const program: NotificationProgramInput = {
  name: 'Continue shopping', description: 'Follow up after a product view', channel: 'in_app',
  trigger_kind: 'product_view', title_template: 'Hello {{customer.first_name}}',
  body_template: 'Take another look at {{product.name}}.', status: 'draft',
  delay_minutes: 60, lookback_days: 7, cooldown_hours: 24, suppress_after_purchase: true,
};
afterEach(() => vi.unstubAllGlobals());

it('keeps generated content separate from any delivery endpoint and preserves the retry key', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const input = { customer_id: 'customer-1', version: 3, idempotency_key: 'stable-request-key' };
  await marketingNotificationApi.generate('program-1', input);
  expect(fetch).toHaveBeenCalledWith('/api/v1/admin/marketing/notifications/program-1/generate', expect.objectContaining({
    method: 'POST', credentials: 'include', cache: 'no-store',
    headers: { 'content-type': 'application/json', 'X-Commerce-Request': '1' }, body: JSON.stringify(input),
  }));
});

it('sends version-checked updates and authoritative preview context without client-supplied customer facts', async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
  vi.stubGlobal('fetch', fetch);
  await marketingNotificationApi.update('program/1', { ...program, version: 4 });
  const signal = new AbortController().signal;
  await marketingNotificationApi.preview({ program, customer_id: 'customer-1', program_id: 'program-1' }, signal);
  expect(fetch.mock.calls[0]).toEqual(['/api/v1/admin/marketing/notifications/program%2F1', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ ...program, version: 4 }) })]);
  expect(fetch.mock.calls[1]).toEqual(['/api/v1/admin/marketing/notifications/preview', expect.objectContaining({ signal, body: JSON.stringify({ program, customer_id: 'customer-1', program_id: 'program-1' }) })]);
});

it('encodes filters and pagination without dropping offset zero', async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
  vi.stubGlobal('fetch', fetch);
  await marketingNotificationApi.list({ search: 'A&B', status: 'active', offset: 0, limit: 20 });
  await marketingNotificationApi.records({ program_id: 'a/b', offset: 20, limit: 20 });
  await marketingNotificationApi.audit('a/b');
  await marketingNotificationApi.get('a/b');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/v1/admin/marketing/notifications?search=A%26B&status=active&offset=0&limit=20',
    '/api/v1/admin/marketing/notifications/records?program_id=a%2Fb&offset=20&limit=20',
    '/api/v1/admin/marketing/notifications/a%2Fb/audit',
    '/api/v1/admin/marketing/notifications/a%2Fb',
  ]);
});

it('preserves concurrency and permission errors with useful recovery messages', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response('{"error":"stale_version"}', { status: 409 }))
    .mockResolvedValueOnce(new Response('{"error":"Missing orders.read permission"}', { status: 403 }))
    .mockResolvedValueOnce(new Response('Gateway unavailable', { status: 502 })));
  await expect(marketingNotificationApi.update('one', { ...program, version: 2 })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('unsaved edits') });
  await expect(marketingNotificationApi.records()).rejects.toMatchObject({ status: 403, message: 'Missing orders.read permission' });
  await expect(marketingNotificationApi.metadata()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('Please try again') });
});

it('preserves exact condition amounts and currency in saved definitions and customer previews', async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
  vi.stubGlobal('fetch', fetch);
  const definition: NotificationProgramInput = { ...program, trigger_kind: 'purchase', conditions: {
    match: 'all', rules: [
      { field: 'customer.verified', operator: 'eq', value: 'true' },
      { field: 'order.total', operator: 'gte', value: '999999999999.99', currency: 'EGP' },
    ],
  } };
  await marketingNotificationApi.update('program-1', { ...definition, version: 4 });
  await marketingNotificationApi.preview({ program: definition, program_id: 'program-1', customer_id: 'customer-1' });
  expect(JSON.parse(fetch.mock.calls[0][1].body).conditions).toEqual(definition.conditions);
  expect(JSON.parse(fetch.mock.calls[1][1].body).program.conditions).toEqual(definition.conditions);
  expect(JSON.parse(fetch.mock.calls[0][1].body).version).toBe(4);
});
