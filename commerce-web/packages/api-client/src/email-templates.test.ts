import { afterEach, expect, it, vi } from 'vitest';
import { emailTemplatesApi, type EmailTemplateContent } from './email-templates';
import { ApiError } from './identity';

const content: EmailTemplateContent = { subject: 'Welcome to {{brand_name}}', heading: 'Confirm your account', body: 'Expires in {{expires_minutes}} minutes.', cta_label: 'Confirm email' };
afterEach(() => vi.unstubAllGlobals());

it('sends a revision-checked draft with a CSRF marker and audit note', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ revision: 8 })));
  vi.stubGlobal('fetch', fetch);
  await emailTemplatesApi.save('verify', { content, expected_revision: 7, change_note: 'Brand voice update' });
  expect(fetch).toHaveBeenCalledWith('/api/v1/admin/email-templates/verify', expect.objectContaining({
    method: 'PUT', credentials: 'include', cache: 'no-store',
    headers: { 'content-type': 'application/json', 'X-Commerce-Request': '1' },
    body: JSON.stringify({ content, expected_revision: 7, change_note: 'Brand voice update' }),
  }));
});

it('uses the read-only sample preview without accepting a recipient or live context', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ subject: 'Welcome', text: 'Preview', html: '<p>Preview</p>' })));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  await emailTemplatesApi.preview('verify', content, signal);
  expect(fetch).toHaveBeenCalledWith('/api/v1/admin/email-templates/verify/preview', expect.objectContaining({ method: 'POST', signal, body: JSON.stringify({ content }) }));
});

it('preserves distinct save, publish, restore, detail, and paginated history endpoints', async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
  vi.stubGlobal('fetch', fetch);
  const change = { expected_revision: 9, change_note: 'Approved by brand team' };
  await emailTemplatesApi.list();
  await emailTemplatesApi.get('order/key');
  await emailTemplatesApi.publish('order', change);
  await emailTemplatesApi.restore('order', { ...change, version: 3 });
  await emailTemplatesApi.history('order');
  await emailTemplatesApi.history('order', 5);
  expect(fetch.mock.calls.map(call => call[0])).toEqual([
    '/api/v1/admin/email-templates', '/api/v1/admin/email-templates/order%2Fkey',
    '/api/v1/admin/email-templates/order/publish', '/api/v1/admin/email-templates/order/restore',
    '/api/v1/admin/email-templates/order/history', '/api/v1/admin/email-templates/order/history?before_version=5',
  ]);
  expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'POST', body: JSON.stringify(change) });
  expect(fetch.mock.calls[3][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ ...change, version: 3 }) });
});

it('preserves concurrency status and gives a recovery message without overwriting the draft', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"stale_revision"}', { status: 409 })));
  const operation = emailTemplatesApi.publish('verify', { expected_revision: 1, change_note: 'Publish update' });
  await expect(operation).rejects.toBeInstanceOf(ApiError);
  await expect(operation).rejects.toMatchObject({ status: 409, message: expect.stringContaining('unsaved changes are still here') });
});

it('surfaces validation errors and tolerates non-JSON gateway failures', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"error":"Required placeholder missing"}', { status: 400 })).mockResolvedValueOnce(new Response('Bad gateway', { status: 502 })));
  await expect(emailTemplatesApi.preview('verify', content)).rejects.toMatchObject({ status: 400, message: 'Required placeholder missing' });
  await expect(emailTemplatesApi.list()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('Please try again') });
});
