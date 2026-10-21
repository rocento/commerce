import { expect, test, type Page } from '@playwright/test';
import type {
  GeneratedNotification, NotificationAuditEvent, NotificationConditionField, NotificationConditionResult, NotificationMetadata,
  NotificationProgram, NotificationProgramInput,
} from '../../packages/api-client/src/marketing-notifications';

const actor = '10000000-0000-4000-8000-000000000001';
const customer = '20000000-0000-4000-8000-000000000001';
const programId = '30000000-0000-4000-8000-000000000001';
const recordId = '40000000-0000-4000-8000-000000000001';
const base = '/marketing/notifications?workspace=journeys';
const api = '/api/v1/admin/marketing/notifications';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const comparisonOperators: NotificationConditionField['operators'] = [
  { id: 'eq', label: 'is equal to' }, { id: 'gte', label: 'is at least' }, { id: 'lte', label: 'is at most' },
];

const metadata: NotificationMetadata = {
  delivery_mode: 'generation_only',
  channels: [
    { id: 'in_app', label: 'In-app', delivery_enabled: false },
    { id: 'email', label: 'Email', delivery_enabled: false },
    { id: 'sms', label: 'SMS', delivery_enabled: false },
    { id: 'whatsapp', label: 'WhatsApp', delivery_enabled: false },
    { id: 'push', label: 'Push', delivery_enabled: false },
  ],
  triggers: [
    { id: 'visit', label: 'Store visit', requires_orders: false },
    { id: 'product_view', label: 'Product viewed', requires_orders: false },
    { id: 'cart.item_added', label: 'Added to cart', requires_orders: false },
    { id: 'purchase', label: 'Order placed', requires_orders: true },
    { id: 'order_status', label: 'Order status changed', requires_orders: true },
  ],
  tokens: [
    { key: 'customer.first_name', label: 'Customer first name' },
    { key: 'customer.name', label: 'Customer name' },
    { key: 'product.name', label: 'Product name' },
    { key: 'order.number', label: 'Order number' },
    { key: 'order.total', label: 'Order total' },
    { key: 'order.currency', label: 'Order currency' },
  ],
  condition_fields: [
    { key: 'customer.verified', label: 'Customer verification', type: 'boolean', operators: [{ id: 'eq', label: 'is' }], options: [{ value: 'true', label: 'Verified' }, { value: 'false', label: 'Not verified' }], triggers: [], description: 'Whether the customer account is verified.' },
    { key: 'customer.order_count', label: 'Lifetime order count', type: 'integer', operators: comparisonOperators, options: [], triggers: [], description: 'All recorded orders, including cancelled orders.' },
    { key: 'customer.account_age_days', label: 'Account age in days', type: 'integer', operators: comparisonOperators, options: [], triggers: [], description: 'Whole days since the customer account was created.' },
    { key: 'product.name', label: 'Viewed product name', type: 'text', operators: [{ id: 'eq', label: 'is equal to' }, { id: 'contains', label: 'contains' }], options: [], triggers: ['product_view', 'cart.item_added', 'cart.item_removed'], description: 'The product name on the matching journey event, compared without case sensitivity.' },
    { key: 'order.status', label: 'Order status', type: 'select', operators: [{ id: 'eq', label: 'is' }, { id: 'neq', label: 'is not' }], options: ['confirmed', 'fulfilling', 'shipped', 'delivered', 'cash_collected', 'cancelled', 'delivery_failed', 'pickup_ready', 'picked_up'].map(value => ({ value, label: value.replaceAll('_', ' ') })), triggers: ['order_status'], description: 'The lifecycle status on the matching order event.' },
    { key: 'order.total', label: 'Order total', type: 'money', operators: comparisonOperators, options: [], triggers: ['checkout', 'purchase'], description: 'Order amount in the specified currency.' },
    { key: 'order.currency', label: 'Order currency', type: 'text', operators: [{ id: 'eq', label: 'is' }], options: [], triggers: ['checkout', 'purchase'], description: 'Three-letter uppercase currency on the order event.' },
  ],
};

function programFixture(): NotificationProgram {
  return {
    id: programId, name: 'Browse recovery', description: 'A helpful product reminder.',
    channel: 'in_app', trigger_kind: 'product_view', status: 'active',
    title_template: 'Hello {{customer.first_name}}',
    body_template: 'Take another look at {{product.name}}.',
    delay_minutes: 0, lookback_days: 7, cooldown_hours: 24,
    suppress_after_purchase: true, version: 1,
    created_at: '2026-10-04T09:00:00Z', updated_at: '2026-10-04T09:00:00Z',
  };
}

async function setup(page: Page, permissions = ['*']) {
  const programs = [programFixture()];
  const records: GeneratedNotification[] = [];
  const events: NotificationAuditEvent[] = [{
    id: '50000000-0000-4000-8000-000000000001', action: 'created',
    actor_id: actor, created_at: '2026-10-04T09:00:00Z', version: 1,
  }];
  const writes: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const requests: string[] = [];
  const state = {
    conflict: false, failList: false, failPreview: false, eligible: true,
    abortGenerationOnce: false, suppressGenerationOnce: false,
    previewReasons: null as string[] | null,
    conditionsMatched: true,
    conditionResults: [] as NotificationConditionResult[],
  };
  const render = (value: string) => value.replaceAll('{{customer.first_name}}', 'Maya')
    .replaceAll('{{customer.name}}', 'Maya Hassan').replaceAll('{{product.name}}', 'Everyday tote');

  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    requests.push(path);
    if (path.endsWith('/admin/me')) return route.fulfill({ json: {
      user: { id: actor, name: 'Marketing administrator', email: 'admin@example.test' }, permissions,
    } });
    if (path === '/api/v1/admin/grids/customers') return route.fulfill({ json: {
      items: [{ id: customer, first_name: 'Maya', last_name: 'Hassan', email: 'maya@example.test', mobile_number: null }],
      next_cursor: null,
    } });
    if (path === `/api/v1/admin/customers/${customer}/profile`) return route.fulfill({ json: {
      first_name: 'Maya', last_name: 'Hassan', date_of_birth: null, gender: '', attributes: {},
      customer_group: 'general', company_id: null, negotiated_price_list_id: null, locations: [],
      account: { id: customer, email: 'maya@example.test', mobile_number: null,
        primary_identifier: 'email', verified: true, created_at: '2026-09-01T00:00:00Z' },
    } });
    if (!path.startsWith(api)) return route.fulfill({ json: path.includes('capabilities')
      ? { system: {}, stores: [], locations: [], sources: [] } : [] });
    if (path === `${api}/campaigns`) return route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 10 } });
    if (path === `${api}/metadata`) return route.fulfill({ json: metadata });
    if (path === `${api}/publications`) return route.fulfill({ json: { publications: [], total: 0 } });
    if (path === `${api}/records`) {
      const matching = records.filter(item => !url.searchParams.get('program_id') || item.program_id === url.searchParams.get('program_id'));
      return route.fulfill({ json: { records: matching, total: matching.length } });
    }
    if (path === api && method === 'GET') {
      if (state.failList) return route.fulfill({ status: 503, json: { error: 'Notification service is temporarily unavailable.' } });
      const search = url.searchParams.get('search')?.toLowerCase() ?? '';
      const status = url.searchParams.get('status');
      const matching = programs.filter(item => item.name.toLowerCase().includes(search) && (!status || item.status === status));
      return route.fulfill({ json: { programs: matching, total: matching.length } });
    }
    if (path.endsWith('/audit')) return route.fulfill({ json: { events } });
    const saved = programs.find(item => path === `${api}/${item.id}` || path === `${api}/${item.id}/generate`);
    if (method === 'GET') return route.fulfill({ json: saved });
    const body = request.postDataJSON() as Record<string, unknown>;
    writes.push({ path, method, body });
    if (path === `${api}/preview`) {
      if (state.failPreview) return route.fulfill({ status: 400, json: { error: 'This preview could not be evaluated.' } });
      const program = body.program as NotificationProgramInput;
      return route.fulfill({ json: {
        title: render(program.title_template), body: render(program.body_template),
        event_id: 'journey:60000000-0000-4000-8000-000000000001', event_kind: program.trigger_kind,
        eligible: state.eligible, reasons: state.previewReasons ?? (state.eligible ? [] : ['This customer is within the cooldown period.']),
        missing_tokens: [], context: { 'customer.first_name': 'Maya', 'customer.name': 'Maya Hassan', 'product.name': 'Everyday tote' },
        condition_match: program.conditions?.match ?? 'all', conditions_matched: state.conditionsMatched,
        condition_results: state.conditionResults,
      } });
    }
    if (path === api && method === 'POST') {
      const record: NotificationProgram = { ...body as unknown as NotificationProgramInput,
        id: '30000000-0000-4000-8000-000000000002', version: 1,
        created_at: '2026-10-04T10:00:00Z', updated_at: '2026-10-04T10:00:00Z' };
      programs.unshift(record);
      return route.fulfill({ status: 201, json: record });
    }
    if (!saved) return route.fulfill({ status: 404, json: { error: 'Program not found.' } });
    if (state.conflict || body.version !== saved.version) return route.fulfill({ status: 409, json: { error: 'The saved program has changed.' } });
    if (method === 'PUT') {
      Object.assign(saved, clone(body), { version: saved.version + 1, updated_at: '2026-10-04T10:00:00Z' });
      events.unshift({ id: '50000000-0000-4000-8000-000000000002', action: 'updated', actor_id: actor,
        created_at: '2026-10-04T10:00:00Z', version: saved.version });
      return route.fulfill({ json: saved });
    }
    if (path.endsWith('/generate')) {
      if (state.abortGenerationOnce) {
        state.abortGenerationOnce = false;
        return route.abort('failed');
      }
      if (state.suppressGenerationOnce) {
        state.suppressGenerationOnce = false;
        return route.fulfill({ json: { outcome: 'suppressed', reason: 'Eligibility changed before generation.', record: null } });
      }
      if (!state.eligible) return route.fulfill({ json: { outcome: 'suppressed', reason: 'This customer is within the cooldown period.', record: null } });
      const record: GeneratedNotification = { id: recordId, program_id: saved.id, program_name: saved.name,
        program_version: saved.version, customer_id: customer,
        event_id: 'journey:60000000-0000-4000-8000-000000000001', channel: saved.channel,
        title: render(saved.title_template), body: render(saved.body_template), status: 'generated',
        created_at: '2026-10-04T10:00:00Z' };
      const outcome = records.length ? 'duplicate' : 'generated';
      if (!records.length) records.push(record);
      return route.fulfill({ json: { outcome, reason: null, record } });
    }
    return route.fulfill({ status: 404, json: { error: 'Fixture route not found.' } });
  });
  return { programs, records, events, writes, requests, state };
}

async function loadCustomer(page: Page) {
  await page.getByRole('tab', { name: 'Preview & generate', exact: true }).click();
  await page.getByText('Use a customer ID', { exact: true }).click();
  await page.getByLabel('Customer ID', { exact: true }).fill(customer);
  await page.getByRole('button', { name: 'Load customer', exact: true }).click();
}

test('journey preview generates a persisted record with a saved version and request key', async ({ page }, info) => {
  const fixture = await setup(page);
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('notification-program-desktop.png'), fullPage: true });
  await loadCustomer(page);
  await expect(page.getByText('Hello Maya', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('notification-preview-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Generate record', exact: true }).click();
  await expect.poll(() => fixture.records.length).toBe(1);
  const generation = fixture.writes.find(item => item.path.endsWith('/generate'));
  expect(generation?.body).toMatchObject({ customer_id: customer, version: 1 });
  expect(generation?.body.idempotency_key).toEqual(expect.any(String));
  expect(String(generation?.body.idempotency_key).length).toBeGreaterThan(15);
  expect(fixture.records[0]).toMatchObject({ title: 'Hello Maya', status: 'generated' });
  await page.getByRole('tab', { name: 'Generated history', exact: true }).click();
  await expect(page.getByText('Hello Maya', { exact: true })).toBeVisible();
  expect(fixture.requests.every(path => !/twilio|firebase|whatsapp|email-send/.test(path))).toBe(true);
});

test('read-only access hides mutations and customer access gates private content', async ({ page }) => {
  const fixture = await setup(page, ['notifications.read']);
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await expect(page.getByLabel('Program name', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /New journey template/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save program', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Preview & generate', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load customer', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Generate record', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Generated history', exact: true }).click();
  expect(fixture.requests).not.toContain(`${api}/records`);
  expect(fixture.writes).toEqual([]);
  await page.unrouteAll({ behavior: 'wait' });
  const denied = await setup(page, ['catalog.read']);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toHaveCount(0);
  await expect(page.locator('a[href="/marketing/notifications"]')).toHaveCount(0);
  expect(denied.requests.some(path => path.startsWith(api))).toBe(false);
});

test('a changed draft invalidates its preview and cannot generate until saved and reviewed', async ({ page }) => {
  const fixture = await setup(page);
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await loadCustomer(page);
  await expect(page.getByRole('button', { name: 'Generate record', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'Program', exact: true }).click();
  await page.getByLabel('Notification title', { exact: true }).fill('A fresh message');
  await page.getByRole('tab', { name: 'Preview & generate', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate record', exact: true })).toBeDisabled();
  expect(fixture.records).toEqual([]);
});

test('a concurrent edit preserves draft content and requires reload', async ({ page }) => {
  const fixture = await setup(page);
  fixture.state.conflict = true;
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await page.getByLabel('Notification title', { exact: true }).fill('Keep my unsaved work');
  await page.getByRole('button', { name: 'Save program', exact: true }).click();
  await expect(page.getByText('This notification changed', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Notification title', { exact: true })).toHaveValue('Keep my unsaved work');
  await expect(page.getByRole('button', { name: 'Save program', exact: true })).toBeDisabled();
  expect(fixture.programs[0].version).toBe(1);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Reload saved program', exact: true }).click();
  await expect(page.getByLabel('Notification title', { exact: true })).toHaveValue('Keep my unsaved work');
  fixture.state.conflict = false;
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reload saved program', exact: true }).click();
  await expect(page.getByLabel('Notification title', { exact: true })).toHaveValue('Hello {{customer.first_name}}');
});

test('program creation and audit preserve the selected channel as generation intent', async ({ page }) => {
  const fixture = await setup(page);
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await page.getByRole('button', { name: /New journey template/ }).click();
  await page.getByLabel('Program name', { exact: true }).fill('Welcome journey');
  await page.getByLabel('Notification title', { exact: true }).fill('Welcome {{customer.first_name}}');
  await page.getByLabel(/^Notification body/).fill('Thank you for exploring our store.');
  await page.getByText('Advanced settings', { exact: true }).click();
  await page.getByLabel(/^Channel/).selectOption('whatsapp');
  await page.getByRole('button', { name: 'Save program', exact: true }).click();
  await expect.poll(() => fixture.programs.length).toBe(2);
  expect(fixture.programs[0]).toMatchObject({ name: 'Welcome journey', channel: 'whatsapp', status: 'draft' });
  await page.getByRole('tab', { name: 'Audit trail', exact: true }).click();
  await expect(page.getByText('created', { exact: false }).first()).toBeVisible();
  expect(fixture.records).toEqual([]);
});

test('mobile preview and service recovery do not overflow the viewport', async ({ page }, info) => {
  const fixture = await setup(page);
  fixture.state.failList = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await expect(page.getByText('Notification service is temporarily unavailable.')).toBeVisible();
  fixture.state.failList = false;
  await page.getByRole('button', { name: /retry/i }).first().click();
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await expect(page.getByLabel('Program name', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('notification-program-mobile.png'), fullPage: true });
  await loadCustomer(page);
  await expect(page.getByText('Hello Maya', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('notification-preview-mobile.png'), fullPage: true });
});

test('customer search opens a real journey preview and readers cannot generate', async ({ page }) => {
  const fixture = await setup(page, ['notifications.read', 'customers.read', 'orders.read']);
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await page.getByRole('tab', { name: 'Preview & generate', exact: true }).click();
  await page.getByLabel(/^Search customers/).fill('Maya');
  await page.getByRole('button', { name: 'Select customer Maya Hassan', exact: true }).click();
  await expect(page.getByText('Hello Maya', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View journey', exact: false })).toHaveAttribute('href', `/customers/journey/${customer}`);
  await expect(page.getByRole('button', { name: 'Generate record', exact: true })).toBeDisabled();
  expect(fixture.requests).toContain('/api/v1/admin/grids/customers');
  expect(fixture.records).toEqual([]);
});

test('an uncertain generation failure retries with the same idempotency key', async ({ page }) => {
  const fixture = await setup(page);
  fixture.state.abortGenerationOnce = true;
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await loadCustomer(page);
  const generate = page.getByRole('button', { name: 'Generate record', exact: true });
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect.poll(() => fixture.records.length).toBe(1);
  const attempts = fixture.writes.filter(item => item.path.endsWith('/generate'));
  expect(attempts).toHaveLength(2);
  expect(attempts[0].body.idempotency_key).toBe(attempts[1].body.idempotency_key);
});

test('a confirmed suppression uses a new key for the next deliberate attempt', async ({ page }) => {
  const fixture = await setup(page);
  fixture.state.suppressGenerationOnce = true;
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await loadCustomer(page);
  const generate = page.getByRole('button', { name: 'Generate record', exact: true });
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(page.getByText('Generation suppressed', { exact: false })).toBeVisible();
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect.poll(() => fixture.records.length).toBe(1);
  const attempts = fixture.writes.filter(item => item.path.endsWith('/generate'));
  expect(attempts).toHaveLength(2);
  expect(attempts[0].body.idempotency_key).not.toBe(attempts[1].body.idempotency_key);
});

test('the order placed starter saves a draft using purchase event variables', async ({ page }) => {
  const fixture = await setup(page);
  await page.goto(base);
  await page.getByRole('button', { name: 'Order placed', exact: true }).click();
  await expect(page.getByLabel('Program name', { exact: true })).toHaveValue('Thank you for your order');
  await expect(page.getByLabel(/^Journey trigger/)).toHaveValue('purchase');
  await expect(page.getByLabel(/^Notification body/)).toHaveValue(/\{\{order.number\}\}.*\{\{order.total\}\}.*\{\{order.currency\}\}/);
  await page.getByRole('button', { name: 'Save program', exact: true }).click();
  await expect.poll(() => fixture.programs.length).toBe(2);
  expect(fixture.programs[0]).toMatchObject({
    name: 'Thank you for your order', trigger_kind: 'purchase', status: 'draft', suppress_after_purchase: false,
  });
  expect(fixture.records).toEqual([]);
});

test('all and any conditions persist through save and reload without changing the rule values', async ({ page }, info) => {
  const fixture = await setup(page);
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await page.getByRole('button', { name: /Add condition/ }).click();
  await page.getByLabel('Condition 1 field', { exact: true }).selectOption('customer.order_count');
  await page.getByLabel('Condition 1 operator', { exact: true }).selectOption('gte');
  await page.getByLabel('Condition 1 value', { exact: true }).fill('3');
  await page.getByRole('button', { name: /Add condition/ }).click();
  await page.getByLabel('Condition 2 field', { exact: true }).selectOption('product.name');
  await page.getByLabel('Condition 2 operator', { exact: true }).selectOption('contains');
  await page.getByLabel('Condition 2 value', { exact: true }).fill('tote');
  await page.getByLabel('Condition matching', { exact: true }).selectOption('any');
  await page.getByRole('button', { name: 'Save program', exact: true }).click();
  await expect.poll(() => fixture.programs[0].version).toBe(2);
  const rules = [
    { field: 'customer.order_count', operator: 'gte', value: '3' },
    { field: 'product.name', operator: 'contains', value: 'tote' },
  ];
  expect(fixture.programs[0].conditions).toEqual({ match: 'any', rules });
  await expect(page.getByText('Program saved as active. Version 2.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await expect(page.getByLabel('Condition matching', { exact: true })).toHaveValue('any');
  await expect(page.getByLabel('Condition 1 value', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Condition 2 operator', { exact: true })).toHaveValue('contains');
  await expect(page.getByLabel('Condition 2 value', { exact: true })).toHaveValue('tote');
  await page.getByLabel('Condition matching', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Save program', exact: true }).click();
  await expect.poll(() => fixture.programs[0].version).toBe(3);
  expect(fixture.programs[0].conditions).toEqual({ match: 'all', rules });
  await expect(page.getByRole('button', { name: 'Save program', exact: true })).toBeDisabled();
  expect(fixture.writes.filter(item => item.method === 'PUT').map(item => item.body.conditions)).toEqual([{ match: 'any', rules }, { match: 'all', rules }]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('journey-conditions-desktop.png'), fullPage: true });
});

test('the guided journey flow keeps its core steps clear and advanced settings collapsed', async ({ page }) => {
  await setup(page);
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  for (const name of ['1 When', '2 Only if Optional', '3 Message', '4 Review']) await expect(page.getByRole('group', { name, exact: true })).toBeVisible();
  await expect(page.getByLabel('Live message outline')).toContainText('‹Customer first name›');
  await expect(page.getByLabel('Program rule summary')).toContainText('No extra conditions.');
  await expect(page.getByLabel(/^Event lookback/)).not.toBeVisible();
  await expect(page.getByLabel(/^Channel/)).not.toBeVisible();
  await page.getByText('Timing & repeat limits', { exact: true }).click();
  await expect(page.getByLabel(/^Event lookback/)).toBeVisible();
  await page.getByRole('button', { name: 'Test with a customer', exact: false }).click();
  await expect(page.getByRole('tab', { name: 'Preview & generate', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('legacy programs open cleanly and save an explicit empty condition group', async ({ page }) => {
  const fixture = await setup(page);
  expect(fixture.programs[0].conditions).toBeUndefined();
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await expect(page.getByRole('button', { name: 'Save program', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Condition 1 field', { exact: true })).toHaveCount(0);
  await page.getByLabel('Program name', { exact: true }).fill('Updated legacy program');
  await page.getByRole('button', { name: 'Save program', exact: true }).click();
  await expect.poll(() => fixture.programs[0].version).toBe(2);
  expect(fixture.programs[0].conditions).toEqual({ match: 'all', rules: [] });
  await expect(page.getByText('Program saved as active. Version 2.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Updated legacy program/ }).click();
  await expect(page.getByRole('button', { name: 'Save program', exact: true })).toBeDisabled();
});

test('the rule limit is visible and removing a condition restores editing capacity', async ({ page }) => {
  const fixture = await setup(page);
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  const add = page.getByRole('button', { name: /Add condition/ });
  for (let index = 0; index < 10; index += 1) await add.click();
  await expect(page.getByLabel('Condition 10 field', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Condition 11 field', { exact: true })).toHaveCount(0);
  await expect(add).toBeDisabled();
  await page.getByRole('button', { name: 'Remove condition 10', exact: true }).click();
  await expect(page.getByLabel('Condition 10 field', { exact: true })).toHaveCount(0);
  await expect(add).toBeEnabled();
  expect(fixture.writes).toEqual([]);
});

test('integer and money conditions enforce supported operators, bounds, precision and currency', async ({ page }) => {
  const fixture = await setup(page);
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await page.getByLabel(/^Journey trigger/).selectOption('purchase');
  await page.getByRole('button', { name: /Add condition/ }).click();
  await page.getByLabel('Condition 1 field', { exact: true }).selectOption('customer.order_count');
  const operator = page.getByLabel('Condition 1 operator', { exact: true });
  expect(await operator.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(['eq', 'gte', 'lte']);
  const value = page.getByLabel('Condition 1 value', { exact: true });
  const save = page.getByRole('button', { name: 'Save program', exact: true });
  for (const invalid of ['-1', '1.5', '1000000001']) { await value.fill(invalid); await expect(save).toBeDisabled(); }
  await value.fill('1');
  await expect(save).toBeEnabled();
  await page.getByLabel('Condition 1 field', { exact: true }).selectOption('order.total');
  await operator.selectOption('gte');
  const currency = page.getByLabel('Condition 1 currency', { exact: true });
  await currency.fill('USD');
  for (const invalid of ['10.123', '1000000000000']) { await value.fill(invalid); await expect(save).toBeDisabled(); }
  await value.fill('125.50');
  await currency.fill('');
  await expect(save).toBeDisabled();
  await currency.fill('US');
  await expect(save).toBeDisabled();
  await currency.fill('USD');
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => fixture.programs[0].version).toBe(2);
  expect(fixture.programs[0].conditions).toEqual({ match: 'all', rules: [{ field: 'order.total', operator: 'gte', value: '125.50', currency: 'USD' }] });
});

test('the customer preview shows server condition results and obeys server eligibility', async ({ page }, info) => {
  const fixture = await setup(page);
  const conditions = { match: 'all' as const, rules: [{ field: 'customer.order_count', operator: 'gte' as const, value: '5' }, { field: 'product.name', operator: 'contains' as const, value: 'tote' }] };
  fixture.programs[0].conditions = conditions;
  fixture.state.eligible = false;
  fixture.state.conditionsMatched = false;
  fixture.state.previewReasons = ['The saved rules do not match this customer.'];
  fixture.state.conditionResults = [
    { index: 0, field: 'customer.order_count', operator: 'gte', expected: '5', actual: '2', matched: false, reason: 'Only 2 recorded orders are available for this customer.' },
    { index: 1, field: 'product.name', operator: 'contains', expected: 'tote', actual: 'Everyday tote', matched: true, reason: 'The latest viewed product contains the requested text.' },
  ];
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await loadCustomer(page);
  await expect(page.getByText('The saved rules do not match this customer.', { exact: true })).toBeVisible();
  await expect(page.getByText('Only 2 recorded orders are available for this customer.', { exact: true })).toBeVisible();
  await expect(page.getByText('The latest viewed product contains the requested text.', { exact: true })).toBeVisible();
  const checks = page.getByRole('region', { name: 'Condition check', exact: true });
  await expect(checks.getByText('Actual: 2', { exact: true })).toBeVisible();
  await expect(checks.getByText('Actual: Everyday tote', { exact: true })).toBeVisible();
  await expect(checks.getByText('Conditions not met', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate record', exact: true })).toBeDisabled();
  expect(fixture.writes.find(item => item.path.endsWith('/preview'))?.body.program).toMatchObject({ conditions });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('customer-condition-preview-desktop.png'), fullPage: true });
  fixture.state.eligible = true;
  fixture.state.conditionsMatched = true;
  fixture.state.previewReasons = [];
  fixture.state.conditionResults[0] = { ...fixture.state.conditionResults[0], actual: '5', matched: true, reason: 'Five recorded orders now meet the minimum.' };
  await page.getByRole('button', { name: 'Refresh eligibility', exact: true }).click();
  await expect(page.getByText('Five recorded orders now meet the minimum.', { exact: true })).toBeVisible();
  await expect(checks.getByText('Actual: 5', { exact: true })).toBeVisible();
  await expect(checks.getByText('Conditions met', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate record', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Generate record', exact: true }).click();
  await expect.poll(() => fixture.records.length).toBe(1);
  expect(fixture.writes.filter(item => item.path.endsWith('/preview')).every(item => JSON.stringify((item.body.program as NotificationProgramInput).conditions) === JSON.stringify(conditions))).toBe(true);
});

test('changing a trigger retains an incompatible saved condition and blocks save and generation', async ({ page }) => {
  const fixture = await setup(page);
  fixture.programs[0].trigger_kind = 'purchase';
  fixture.programs[0].conditions = { match: 'all', rules: [{ field: 'order.total', operator: 'gte', value: '250', currency: 'EGP' }] };
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await loadCustomer(page);
  await expect(page.getByRole('button', { name: 'Generate record', exact: true })).toBeEnabled();
  const previewCount = fixture.writes.filter(item => item.path.endsWith('/preview')).length;
  await page.getByRole('tab', { name: 'Program', exact: true }).click();
  await page.getByLabel(/^Journey trigger/).selectOption('product_view');
  await expect(page.getByLabel('Condition 1 field', { exact: true })).toHaveValue('order.total');
  await expect(page.getByLabel('Condition 1 value', { exact: true })).toHaveValue('250');
  await expect(page.getByRole('button', { name: 'Save program', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Preview & generate', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate record', exact: true })).toBeDisabled();
  expect(fixture.writes.filter(item => item.path.endsWith('/preview'))).toHaveLength(previewCount);
  expect(fixture.writes.some(item => item.method === 'PUT' || item.path.endsWith('/generate'))).toBe(false);
});

test('condition controls are read-only without write permission', async ({ page }) => {
  const fixture = await setup(page, ['notifications.read']);
  fixture.programs[0].conditions = { match: 'any', rules: [{ field: 'customer.verified', operator: 'eq', value: 'true' }] };
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  for (const name of ['Condition matching', 'Condition 1 field', 'Condition 1 operator', 'Condition 1 value']) await expect(page.getByLabel(name, { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save program', exact: true })).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
});

test('mobile condition rows and their currency controls fit the viewport', async ({ page }, info) => {
  const fixture = await setup(page);
  fixture.programs[0].trigger_kind = 'purchase';
  fixture.programs[0].conditions = { match: 'all', rules: [{ field: 'order.total', operator: 'gte', value: '250', currency: 'EGP' }, { field: 'customer.verified', operator: 'eq', value: 'true' }] };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.getByRole('button', { name: /Browse recovery/ }).click();
  await expect(page.getByLabel('Condition 1 currency', { exact: true })).toHaveValue('EGP');
  await expect(page.getByLabel('Condition 2 value', { exact: true })).toHaveValue('true');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('journey-conditions-mobile.png'), fullPage: true });
});
