import { expect, test, type Page } from '@playwright/test';
import type { GeneratedNotification, NotificationProgram } from '../../packages/api-client/src/marketing-notifications';
import type { NotificationCampaign, NotificationPublication } from '../../packages/api-client/src/storefront-notifications';

const api = '/api/v1/admin/marketing/notifications';
const actorId = '10000000-0000-4000-8000-000000000001';
const customerId = '20000000-0000-4000-8000-000000000001';
const programId = '30000000-0000-4000-8000-000000000001';
const recordId = '40000000-0000-4000-8000-000000000001';
const now = '2026-10-04T12:00:00Z';
const program: NotificationProgram = {
  id: programId, name: 'Journey reminder', description: 'A product reminder', channel: 'in_app',
  trigger_kind: 'product_view', title_template: 'Hello {{customer.first_name}}', body_template: 'Take another look.',
  status: 'active', delay_minutes: 0, lookback_days: 7, cooldown_hours: 24,
  suppress_after_purchase: false, version: 1, created_at: now, updated_at: now,
};
const generated: GeneratedNotification = {
  id: recordId, program_id: programId, program_name: program.name, program_version: 1,
  customer_id: customerId, event_id: 'event:1', channel: 'in_app', title: 'Hello Maya',
  body: 'Your saved selection is ready to explore.', status: 'generated', created_at: now,
};

async function setup(page: Page, permissions = ['*']) {
  await page.clock.setFixedTime(new Date(now));
  const publications: NotificationPublication[] = [];
  const campaigns: NotificationCampaign[] = [];
  const segment = { id: '70000000-0000-4000-8000-000000000001', name: 'Returning customers', status: 'active', matchedCustomers: 42, description: '', rules: [], match: 'all', revision: 1 }; 
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const idempotent = new Map<string, NotificationPublication>();
  const state = { abortAnnouncementOnce: false, withdrawalConflict: false, rejectPublicationOnce: 0 };
  const makePublication = (input: Record<string, unknown>, record?: GeneratedNotification): NotificationPublication => ({
    id: `50000000-0000-4000-8000-${String(publications.length + 1).padStart(12, '0')}`,
    source_record_id: record?.id ?? null, customer_id: record?.customer_id ?? null,
    audience: record ? 'customer' : input.audience as 'all' | 'guests' | 'customers',
    area_ids: input.area_ids as string[] ?? [],
    trigger_product_id: input.trigger_product_id as string | null ?? null,
    title: record?.title ?? String(input.title), body: record?.body ?? String(input.body),
    cta_label: input.cta_label as string | null, cta_path: input.cta_path as string | null,
    published_at: input.starts_at as string | null ?? now, expires_at: String(input.expires_at),
    withdrawn_at: null, version: 1, created_at: now,
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path.startsWith('/api/v1/admin/customer-segments')) return route.fulfill({ json: path.endsWith(segment.id) ? segment : [segment] });
    if (path === '/api/v1/search') return route.fulfill({ json: { hits: [{ id: 'bc0cbb1d-8b21-45e2-8047-b5ac807260f3', name: 'Tomatoes 1kg', sku: 'DEMO-GRO-WHITE-007' }], total: 1, offset: 0, limit: 20 } });
    if (path === '/api/v1/delivery-areas') return route.fulfill({ json: [{ id: '60000000-0000-4000-8000-000000000001', name: 'Cairo', center_lat: 30, center_lng: 31 }, { id: '60000000-0000-4000-8000-000000000002', name: 'Giza', center_lat: 30, center_lng: 30 }] });
    if (path.endsWith('/admin/me')) return route.fulfill({ json: { user: { id: actorId, name: 'Marketing publisher', email: 'publisher@example.test' }, permissions } });
    if (path === `${api}/metadata`) return route.fulfill({ json: {
      delivery_mode: 'generation_only', channels: [{ id: 'in_app', label: 'In-app', delivery_enabled: false }, { id: 'email', label: 'Email', delivery_enabled: false }],
      condition_fields: [{ key: 'product.name', label: 'Product name', type: 'text', operators: [{ id: 'contains', label: 'contains' }], options: [], triggers: ['product_view'], description: 'Matches the viewed product name.' }],
      triggers: [{ id: 'visit', label: 'Store visit', requires_orders: false }, { id: 'product_view', label: 'Product viewed', requires_orders: false }, { id: 'purchase', label: 'Order placed', requires_orders: true }], tokens: [{ key: 'customer.first_name', label: 'Customer first name' }],
    } });
    if (path.startsWith(`${api}/campaigns`)) {
      if (request.method() === 'GET') return route.fulfill({ json: { items: campaigns.filter(item => item.status === 'draft'), total: campaigns.filter(item => item.status === 'draft').length, offset: 0, limit: 10 } });
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      const draft = campaigns.find(item => path.includes(item.id));
      if (path.endsWith('/activate')) {
        if (!draft) return route.fulfill({ status: 404, json: { error: 'Draft not found.' } });
        if (state.rejectPublicationOnce) { const status = state.rejectPublicationOnce; state.rejectPublicationOnce = 0; return route.fulfill({ status, json: { error: 'Administrator session expired. Sign in again before publishing.' } }); }
        const key = String(body.idempotency_key);
        if (idempotent.has(key)) return route.fulfill({ json: idempotent.get(key) });
        const publication = { ...makePublication(draft.announcement as unknown as Record<string, unknown>), audience_rules: draft.announcement.audience_rules };
        publications.unshift(publication); idempotent.set(key, publication); draft.status = 'published'; draft.publication_id = publication.id;
        if (state.abortAnnouncementOnce) { state.abortAnnouncementOnce = false; return route.abort('failed'); }
        return route.fulfill({ json: publication });
      }
      if (draft) { if (state.withdrawalConflict) return route.fulfill({ status: 409, json: { error: 'Draft changed elsewhere.' } }); Object.assign(draft, body, { version: draft.version + 1 }); return route.fulfill({ json: draft }); }
      const created = { ...body, id: `80000000-0000-4000-8000-${String(campaigns.length + 1).padStart(12, '0')}`, version: 1, status: 'draft', publication_id: null, created_at: now, updated_at: now } as NotificationCampaign;
      campaigns.push(created); return route.fulfill({ status: 201, json: created });
    }
    if (path === api) return route.fulfill({ json: { programs: [program], total: 1 } });
    if (path === `${api}/records`) return route.fulfill({ json: { records: [generated, { ...generated, id: '40000000-0000-4000-8000-000000000002', channel: 'email', title: 'Email preparation' }], total: 2 } });
    if (path === `${api}/publications` && request.method() === 'GET') {
      const search = (url.searchParams.get('search') ?? '').toLowerCase(), status = url.searchParams.get('status') ?? 'all';
      const matches = publications.filter(item => `${item.title} ${item.body}`.toLowerCase().includes(search) && (status === 'all' || (status === 'withdrawn' ? !!item.withdrawn_at : !item.withdrawn_at)));
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 25);
      return route.fulfill({ json: { publications: matches.slice(offset, offset + limit), total: matches.length } });
    }
    if (path.startsWith(`${api}/publications`) || path.endsWith('/publish')) {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      if (request.method() === 'DELETE') {
        const index = publications.findIndex(item => path.endsWith(item.id));
        if (index < 0) return route.fulfill({ status: 404, json: { error: 'Not found' } });
        if (state.withdrawalConflict || body.version !== publications[index].version) return route.fulfill({ status: 409, json: { error: 'Publication changed.' } });
        const [removed] = publications.splice(index, 1);
        return route.fulfill({ json: { id: removed.id, deleted: true } });
      }
      if (path.endsWith('/withdraw')) {
        const publication = publications.find(item => path.includes(item.id));
        if (!publication) return route.fulfill({ status: 404, json: { error: 'Publication not found.' } });
        if (state.withdrawalConflict || body.version !== publication.version) return route.fulfill({ status: 409, json: { error: 'Publication changed. Reload before withdrawing.' } });
        publication.withdrawn_at = now; publication.version += 1;
        return route.fulfill({ json: publication });
      }
      const key = String(body.idempotency_key);
      if (state.rejectPublicationOnce) {
        const status = state.rejectPublicationOnce;
        state.rejectPublicationOnce = 0;
        return route.fulfill({ status, json: { error: 'Administrator session expired. Sign in again before publishing.' } });
      }
      if (idempotent.has(key)) return route.fulfill({ json: idempotent.get(key) });
      const publication = makePublication(body, path.endsWith('/publish') ? generated : undefined);
      publications.unshift(publication); idempotent.set(key, publication);
      if (state.abortAnnouncementOnce && path === `${api}/publications`) { state.abortAnnouncementOnce = false; return route.abort('failed'); }
      return route.fulfill({ status: 201, json: publication });
    }
    return route.fulfill({ json: path.includes('capabilities') ? { system: {}, stores: [], locations: [], sources: [] } : [] });
  });
  return { publications, campaigns, writes, state, makePublication };
}

async function openAnnouncements(page: Page) { await page.goto('/marketing/notifications'); }
async function compose(page: Page, title = 'A useful store update') {
  await page.getByRole('button', { name: 'New campaign', exact: true }).click();
  await page.getByLabel('Campaign name', { exact: true }).fill('Autumn discovery');
  await page.getByLabel('Notification title', { exact: true }).fill(title);
  await page.getByLabel('Notification message', { exact: true }).fill('Explore the latest collection in our store.');
}
async function audience(page: Page) { await page.getByRole('button', { name: 'Continue to audience', exact: true }).click(); }
async function review(page: Page) {
  await page.getByRole('button', { name: 'Continue to timing', exact: true }).click();
  await page.getByRole('button', { name: 'Review campaign', exact: true }).click();
}

test('readers can inspect publications but cannot publish or withdraw', async ({ page }) => {
  const fixture = await setup(page, ['notifications.read', 'customers.read', 'orders.read']);
  fixture.publications.push(fixture.makePublication({ audience: 'all', title: 'Current announcement', body: 'Visible copy.', cta_label: null, cta_path: null, starts_at: null, expires_at: '2026-10-08T12:00:00Z' }));
  await openAnnouncements(page);
  await expect(page.getByLabel('Publication: Current announcement')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New campaign', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Withdraw publication', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browse templates', exact: true }).click();
  await page.getByRole('button', { name: /Journey reminder/ }).click();
  await page.getByRole('tab', { name: 'Generated history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish to customer inbox', exact: true })).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
});

test('withdrawal uses the saved version and stale changes require a reload', async ({ page }) => {
  const fixture = await setup(page);
  fixture.publications.push(fixture.makePublication({ audience: 'all', title: 'Current announcement', body: 'Visible copy.', cta_label: null, cta_path: null, starts_at: null, expires_at: '2026-10-08T12:00:00Z' }));
  fixture.state.withdrawalConflict = true;
  await openAnnouncements(page);
  await page.getByRole('button', { name: 'Withdraw publication', exact: true }).click();
  expect(fixture.writes).toEqual([]);
  await page.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
  await expect(page.getByText('Publication changed. Reload before withdrawing.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm withdrawal', exact: true })).toBeDisabled();
  fixture.state.withdrawalConflict = false;
  fixture.publications[0].version = 2;
  await page.getByRole('button', { name: 'Reload publications', exact: true }).click();
  const publication = page.getByLabel('Publication: Current announcement');
  await publication.getByText('View full message & details', { exact: true }).click();
  await expect(publication.locator('details').getByText('2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Withdraw publication', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
  await expect(page.getByLabel('Publication: Current announcement')).toContainText('Withdrawn');
  expect(fixture.writes.map(item => item.body.version)).toEqual([1, 2]);
});

test('only an immutable in-app record can be published to its customer', async ({ page }, info) => {
  const fixture = await setup(page);
  await page.goto('/marketing/notifications?workspace=journeys');
  await page.getByRole('button', { name: /Journey reminder/ }).click();
  await page.getByRole('tab', { name: 'Generated history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish to customer inbox', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Publish to customer inbox', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish to customer inbox', exact: true });
  await expect(dialog.getByLabel('Announcement title', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Announcement audience', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Continue to audience & timing', exact: true }).click();
  await expect(dialog).toContainText(customerId);
  await dialog.getByRole('button', { name: 'Review customer publication', exact: true }).click();
  await expect(dialog.getByLabel('Storefront notification preview')).toContainText('Hello Maya');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('notification-customer-publish-desktop.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Publish to this customer', exact: true }).click();
  await expect(dialog.getByText('Customer message published.', { exact: false })).toBeVisible();
  expect(fixture.writes[0].path).toBe(`${api}/records/${recordId}/publish`);
  expect(fixture.writes[0].body).not.toHaveProperty('customer_id');
  expect(fixture.writes[0].body).not.toHaveProperty('title');
  expect(fixture.publications[0]).toMatchObject({ audience: 'customer', customer_id: customerId, source_record_id: recordId, title: 'Hello Maya' });
});

test('one campaign saves a persistent audience draft, reopens it, and explicitly activates its schedule', async ({ page }, info) => {
  const fixture = await setup(page); await openAnnouncements(page); await compose(page);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. It is not visible to customers.')).toBeVisible();
  expect(fixture.publications).toHaveLength(0); expect(fixture.campaigns).toHaveLength(1);
  await page.getByRole('button', { name: 'Close campaign', exact: true }).click();
  await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
  await expect(page.getByLabel('Notification title', { exact: true })).toHaveValue('A useful store update');
  await page.getByLabel('Notification title', { exact: true }).fill('A carefully planned update');
  await audience(page);
  await page.getByLabel('Audience', { exact: true }).selectOption('customers');
  await page.getByRole('checkbox', { name: /Returning customers/ }).check();
  await page.getByLabel('Start delivery when', { exact: true }).selectOption('product_view');
  await page.getByRole('button', { name: 'Add condition', exact: false }).click();
  await page.getByLabel('Condition 1 value', { exact: true }).fill('Tomatoes');
  await page.getByRole('button', { name: 'Continue to timing', exact: true }).click();
  await page.getByLabel('Campaign starts', { exact: true }).selectOption('later');
  await page.getByLabel('Start time', { exact: true }).fill('2026-10-05T18:00');
  await page.getByLabel('Delay after event (minutes)', { exact: true }).fill('20');
  await page.getByLabel('Delivery frequency', { exact: true }).selectOption('repeat');
  await page.getByLabel('Cooldown between messages (hours)', { exact: true }).fill('48');
  await page.getByRole('button', { name: 'Review campaign', exact: true }).click();
  await expect(page.getByText('Segments: Returning customers')).toBeVisible();
  expect(fixture.publications).toHaveLength(0);
  await page.evaluate(() => window.scrollTo(0,0)); await page.screenshot({ path: info.outputPath('campaign-review-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Schedule campaign', exact: true }).click();
  await expect(page.getByText('Campaign scheduled for signed-in customers.', { exact: true })).toBeVisible();
  expect(fixture.publications).toHaveLength(1); expect(fixture.campaigns[0].version).toBe(2);
  expect(fixture.campaigns[0].announcement).toMatchObject({ audience: 'customers', audience_rules: { segment_ids: ['70000000-0000-4000-8000-000000000001'], trigger_kind: 'product_view', delay_minutes: 20, cooldown_hours: 48, max_deliveries: 3, conditions: { match: 'all', rules: [{ field: 'product.name', operator: 'contains', value: 'Tomatoes' }] } } });
  await expect(page.getByLabel('Publication: A carefully planned update')).toContainText('Scheduled');
});

test('changing the journey preserves incompatible conditions and blocks activation', async ({ page }) => {
  const fixture = await setup(page); await openAnnouncements(page); await compose(page); await audience(page);
  await page.getByLabel('Start delivery when').selectOption('product_view');
  await page.getByRole('button', { name: 'Add condition', exact: false }).click();
  await page.getByLabel('Condition 1 value').fill('Tomatoes');
  await page.getByLabel('Start delivery when').selectOption('visit');
  await expect(page.getByText('This condition does not apply to the selected event.', { exact: false })).toBeVisible();
  await review(page);
  await expect(page.getByText('Condition 1: Product name is not available for this event.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activate campaign', exact: true })).toHaveCount(0);
  expect(fixture.publications).toHaveLength(0); expect(fixture.writes).toHaveLength(0);
});

test('guest product campaigns validate product selection and keep audience filters in their saved plan', async ({ page }) => {
  const fixture = await setup(page); await openAnnouncements(page); await compose(page); await audience(page);
  await page.getByLabel('Audience', { exact: true }).selectOption('guests');
  await expect(page.getByRole('option', { name: 'Order placed', exact: true })).toHaveCount(0);
  await page.getByLabel('Start delivery when').selectOption('product_view');
  await page.getByLabel('Product scope').selectOption('selected');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Choose a product for the visit trigger.')).toBeVisible();
  await page.getByLabel('Find a product', { exact: true }).fill('Tomatoes');
  await page.getByRole('radio', { name: 'Tomatoes 1kg · DEMO-GRO-WHITE-007' }).check();
  await page.getByText('Delivery location', { exact: true }).click();
  await page.getByLabel('Location targeting').selectOption('selected');
  await page.getByRole('checkbox', { name: 'Cairo', exact: true }).check();
  await review(page); await page.getByRole('button', { name: 'Activate campaign', exact: true }).click();
  await expect(page.getByText('Campaign activated for guests.', { exact: true })).toBeVisible();
  expect(fixture.campaigns[0].announcement).toMatchObject({ audience: 'guests', trigger_product_id: 'bc0cbb1d-8b21-45e2-8047-b5ac807260f3', area_ids: ['60000000-0000-4000-8000-000000000001'] });
});

test('unconfirmed activation retries the same request without a duplicate campaign or publication', async ({ page }) => {
  const fixture = await setup(page); fixture.state.abortAnnouncementOnce = true;
  await openAnnouncements(page); await compose(page); await audience(page); await review(page);
  await page.getByRole('button', { name: 'Activate campaign', exact: true }).click();
  await expect(page.getByText('Activation could not be confirmed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit audience & rules' })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry activation' }).click();
  await expect(page.getByText('Campaign activated for everyone.', { exact: true })).toBeVisible();
  const activations = fixture.writes.filter(write => write.path.endsWith('/activate'));
  expect(activations).toHaveLength(2); expect(activations[0].body.idempotency_key).toBe(activations[1].body.idempotency_key);
  expect(fixture.campaigns).toHaveLength(1); expect(fixture.publications).toHaveLength(1);
});

test('draft editors can prepare and save campaigns without publishing permission', async ({ page }) => {
  const fixture = await setup(page, ['notifications.read', 'notifications.write', 'customers.read', 'orders.read']);
  await openAnnouncements(page); await compose(page); await audience(page); await review(page);
  await expect(page.getByRole('button', { name: 'Activate campaign', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. It is not visible to customers.')).toBeVisible();
  expect(fixture.campaigns).toHaveLength(1); expect(fixture.publications).toHaveLength(0);
});

test('draft concurrency conflicts preserve entered content and block stale activation', async ({ page }) => {
  const fixture = await setup(page); await openAnnouncements(page); await compose(page);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. It is not visible to customers.')).toBeVisible();
  fixture.state.withdrawalConflict = true;
  await page.getByLabel('Notification title', { exact: true }).fill('My unsaved correction');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('This draft changed elsewhere.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Notification title', { exact: true })).toHaveValue('My unsaved correction');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  expect(fixture.publications).toHaveLength(0);
});

test('mobile campaign builder and review fit a narrow screen', async ({ page }, info) => {
  await setup(page); await page.setViewportSize({ width: 390, height: 844 });
  await openAnnouncements(page); await compose(page); await audience(page);
  await page.getByLabel('Start delivery when').selectOption('product_view');
  await page.getByRole('button', { name: 'Add condition', exact: false }).click();
  await page.getByLabel('Condition 1 value').fill('Tomatoes');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0,0)); await page.screenshot({ path: info.outputPath('campaign-audience-mobile.png'), fullPage: true });
  await review(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0,0)); await page.screenshot({ path: info.outputPath('campaign-review-mobile.png'), fullPage: true });
});

test('authors without private-data access cannot select the signed-in audience', async ({ page }) => {
  const fixture = await setup(page, ['notifications.read', 'notifications.write']);
  await openAnnouncements(page); await compose(page); await audience(page);
  await expect(page.getByRole('option', { name: 'Signed-in customers — Customer and Orders access required', exact: true })).toHaveJSProperty('disabled', true);
  await expect(page.getByLabel('Audience', { exact: true })).toHaveValue('all');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. It is not visible to customers.')).toBeVisible();
  expect(fixture.campaigns[0].announcement.audience).toBe('all');
});
