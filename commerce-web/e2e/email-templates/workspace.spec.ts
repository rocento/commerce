import { expect, test, type Page } from '@playwright/test';
import type { EmailTemplate, EmailTemplateContent, EmailTemplateVersion } from '../../packages/api-client/src/email-templates';

const actor = '10000000-0000-4000-8000-000000000001';
const base = '/marketing/email-templates';
const api = '/api/v1/admin/email-templates';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function fixture(): EmailTemplate[] {
  return [
    ['verify', 'Registration confirmation', 'Verify a new customer’s email address.'],
    ['reset', 'Password reset', 'Help customers securely reset their password.'],
    ['order', 'Order confirmation', 'Confirm a placed order with its total and payment details.'],
    ['shipment', 'Shipment confirmation', 'Notify customers when their order ships, including tracking details.'],
  ].map(([key, name, description]) => {
    const account = ['verify', 'reset'].includes(key);
    return {
      key, name, description, category: account ? 'account' : 'orders', revision: 0,
      draft: {
        subject: account ? 'Your {{brand_name}} account' : 'Your {{brand_name}} order',
        heading: account ? 'Welcome to {{brand_name}}' : 'Thank you for your order',
        body: account ? 'Confirm your account.\n\nThis link expires {{expires_minutes}} minutes after it was requested.' : 'Thanks for shopping with us.\n\n{{message}}',
        cta_label: account ? 'Verify email address' : null,
      },
      published: null, published_version: null, has_unpublished_changes: false,
      updated_at: null, updated_by: null,
      variables: [
        { name: 'brand_name', description: 'Store name', sample: 'Rocento', required: false },
        ...(account ? [
          { name: 'expires_minutes', description: 'Expiry in minutes', sample: '15', required: true },
          { name: 'action_url', description: 'Secure single-use link', sample: 'https://store.example.test/confirm', required: false },
        ] : [{ name: 'message', description: 'Order details', sample: 'Order #1042 confirmed. Total: 125.50 EGP.', required: true }]),
      ],
    };
  });
}

async function setup(page: Page, permissions = ['*']) {
  const records = fixture();
  const versions: Record<string, EmailTemplateVersion[]> = {};
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const requests: string[] = [];
  const state = { conflict: false, failList: false, failPreview: false };
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    requests.push(path);
    if (path.endsWith('/admin/me')) return route.fulfill({ json: { user: { id: actor, name: 'Email administrator', email: 'admin@example.test' }, permissions } });
    if (!path.startsWith(api)) return route.fulfill({ json: path.includes('capabilities') ? { system: {}, stores: [], locations: [], sources: [] } : [] });
    if (path === api) return state.failList ? route.fulfill({ status: 503, json: { error: 'Template service is temporarily unavailable.' } }) : route.fulfill({ json: { items: records } });
    const [key, action] = path.slice(api.length + 1).split('/');
    const record = records.find(item => item.key === key);
    if (!record) return route.fulfill({ status: 404, json: { error: 'Template not found.' } });
    if (method === 'GET') return route.fulfill({ json: action === 'history' ? { items: versions[key] ?? [], next_before_version: null } : record });
    const input = request.postDataJSON() as Record<string, unknown>;
    if (action === 'preview') {
      if (state.failPreview) return route.fulfill({ status: 400, json: { error: 'This draft cannot be previewed. Check its variables.' } });
      const content = input.content as EmailTemplateContent;
      const render = (value: string) => value.replaceAll('{{brand_name}}', 'Rocento').replaceAll('{{expires_minutes}}', '15').replaceAll('{{message}}', 'Order #1042 confirmed. Total: 125.50 EGP.');
      const text = `${render(content.heading)}\n\n${render(content.body)}`;
      return route.fulfill({ json: {
        subject: render(content.subject), text,
        html: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:24px;background:#f5f5f5;font-family:Arial,sans-serif;color:#172a25"><main style="padding:24px;background:white;border-radius:12px"><h1 style="font-size:24px">${escape(render(content.heading))}</h1><p style="line-height:1.7">${escape(render(content.body)).replaceAll('\n', '<br>')}</p>${content.cta_label ? `<p style="margin-top:24px"><a href="https://example.test/preview" style="display:inline-block;background:#075e45;color:white;padding:14px 20px;border-radius:6px;text-decoration:none">${escape(content.cta_label)}</a></p>` : ''}<p style="margin-top:32px;color:#677970;font-size:13px">Rocento</p></main></body></html>`,
      } });
    }
    writes.push({ path, method, body: input });
    if (state.conflict || input.expected_revision !== record.revision) return route.fulfill({ status: 409, json: { error: 'Stale revision.', code: 'stale_revision' } });
    if (method === 'PUT') record.draft = clone(input.content as EmailTemplateContent);
    if (action === 'publish') {
      record.published = clone(record.draft);
      record.published_version = (record.published_version ?? 0) + 1;
      (versions[key] ??= []).unshift({ version: record.published_version, content: clone(record.draft), change_note: String(input.change_note), published_at: '2026-10-04T10:00:00Z', published_by: actor });
    }
    if (action === 'restore') record.draft = clone(versions[key].find(item => item.version === input.version)!.content);
    record.revision += 1;
    record.updated_at = '2026-10-04T10:00:00Z'; record.updated_by = actor;
    record.has_unpublished_changes = JSON.stringify(record.draft) !== JSON.stringify(record.published ?? fixture().find(item => item.key === key)!.draft);
    return route.fulfill({ json: record });
  });
  return { records, versions, writes, requests, state };
}

async function saveSubject(page: Page, subject: string) {
  await page.getByRole('tab', { name: 'Content', exact: true }).click();
  await page.getByLabel('Subject line', { exact: true }).fill(subject);
  await page.getByLabel('Reason for this change', { exact: true }).selectOption('Brand voice update');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: false })).toBeVisible();
}

async function publish(page: Page) {
  await page.getByRole('button', { name: 'Review & publish', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Preview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('Publication note', { exact: true }).selectOption('Brand voice update');
  await page.getByRole('button', { name: 'Publish template', exact: true }).click();
  await expect(page.getByText('Template published.', { exact: false })).toBeVisible();
}

test('library search and sample preview are accessible and do not send mail', async ({ page }, info) => {
  const state = await setup(page);
  await page.goto(base);
  await expect(page.getByRole('heading', { level: 1, name: 'Email templates' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Content', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('email-content-desktop.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.getByLabel('Subject line', { exact: true })).not.toBeVisible();
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Welcome to Rocento' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('email-templates-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Plain text', exact: true }).click();
  await expect(page.getByLabel('Plain text email preview')).toContainText('expires 15 minutes');
  await page.getByRole('searchbox', { name: 'Search templates' }).fill('order confirmation');
  await expect(page.locator('.email-template-card')).toHaveCount(1);
  await page.getByRole('button', { name: /Order confirmation/ }).click();
  await expect(page.getByLabel('Subject line', { exact: true })).toHaveValue('Your {{brand_name}} order');
  await page.getByRole('searchbox', { name: 'Search templates' }).fill('no-match');
  await expect(page.getByText('No templates match your filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.email-template-card')).toHaveCount(4);
  expect(state.writes).toEqual([]);
});

test('drafts publish explicitly and restoration does not replace the live version', async ({ page }) => {
  const state = await setup(page);
  await page.goto(base);
  await page.getByLabel('Subject line', { exact: true }).fill('Welcome to our store');
  await expect(page.getByRole('button', { name: 'Review & publish' })).toBeDisabled();
  await page.getByLabel('Reason for this change', { exact: true }).selectOption('Brand voice update');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('System default is live')).toBeVisible();
  await publish(page);
  await expect(page.getByText('Version 1 is live', { exact: true })).toBeVisible();
  await saveSubject(page, 'Welcome, valued customer');
  await publish(page);
  await page.getByRole('tab', { name: 'Version history', exact: true }).click();
  const versionOne = page.locator('.email-version').filter({ has: page.getByRole('heading', { name: 'Version 1', exact: true }) });
  await versionOne.getByRole('button', { name: 'Restore as draft' }).click();
  await page.getByRole('button', { name: 'Confirm restore', exact: true }).click();
  await expect(page.getByText('Version 1 restored as a draft.', { exact: false })).toBeVisible();
  await expect(page.getByText('Version 2 is live', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Content', exact: true }).click();
  await expect(page.getByLabel('Subject line', { exact: true })).toHaveValue('Welcome to our store');
  expect(state.records[0].published?.subject).toBe('Welcome, valued customer');
  expect(state.writes.map(item => item.body.expected_revision)).toEqual([0, 1, 2, 3, 4]);
});

test('viewers cannot edit or publish and unprivileged direct routes never fetch templates', async ({ page }) => {
  const state = await setup(page, ['email_templates.read']);
  await page.goto(base);
  await expect(page.getByLabel('Subject line', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review & publish', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.locator('iframe')).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.unrouteAll({ behavior: 'wait' });
  const denied = await setup(page, ['catalog.read']);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Email templates', exact: true })).toHaveCount(0);
  await expect(page.locator('a[href="/marketing/email-templates"]')).toHaveCount(0);
  expect(denied.requests.some(path => path.startsWith(api))).toBe(false);
});

test('conflicts preserve edits and require an explicit reload', async ({ page }) => {
  const state = await setup(page);
  state.state.conflict = true;
  await page.goto(base);
  await page.getByLabel('Subject line', { exact: true }).fill('My carefully reviewed subject');
  await page.getByLabel('Reason for this change', { exact: true }).selectOption('Brand voice update');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('This template changed in another session.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Subject line', { exact: true })).toHaveValue('My carefully reviewed subject');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Reload latest version', exact: true }).click();
  await expect(page.getByLabel('Subject line', { exact: true })).toHaveValue('My carefully reviewed subject');
  state.state.conflict = false;
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reload latest version', exact: true }).click();
  await expect(page.getByLabel('Subject line', { exact: true })).toHaveValue('Your {{brand_name}} account');
});

test('publishers can refresh a draft saved by another administrator', async ({ page }) => {
  const state = await setup(page, ['email_templates.read', 'email_templates.publish']);
  await page.goto(base);
  await expect(page.getByLabel('Subject line', { exact: true })).toHaveValue('Your {{brand_name}} account');
  await expect(page.getByRole('button', { name: 'Review & publish', exact: true })).toBeDisabled();
  state.records[0].draft.subject = 'A draft from the content team';
  state.records[0].revision = 1;
  state.records[0].has_unpublished_changes = true;
  await page.getByRole('button', { name: 'Reload latest version', exact: true }).click();
  await expect(page.getByLabel('Subject line', { exact: true })).toHaveValue('A draft from the content team');
  await expect(page.getByLabel('Subject line', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toHaveCount(0);
  await publish(page);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].path).toBe(`${api}/verify/publish`);
  expect(state.writes[0].body.expected_revision).toBe(1);
});

test('required variables and unsaved navigation are protected', async ({ page }) => {
  const state = await setup(page);
  await page.goto(base);
  await page.getByLabel('Message body', { exact: true }).fill('A message without expiry.');
  await page.getByLabel('Reason for this change', { exact: true }).selectOption('Brand voice update');
  await expect(page.getByText('Keep {{expires_minutes}} in the message body.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: /Password reset/ }).click();
  await expect(page.getByLabel('Message body', { exact: true })).toHaveValue('A message without expiry.');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /Password reset/ }).click();
  await expect(page.getByRole('heading', { name: 'Password reset', exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test('mobile layout and recoverable service errors', async ({ page }, info) => {
  const state = await setup(page);
  state.state.failList = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await expect(page.getByText('Template service is temporarily unavailable.')).toBeVisible();
  state.state.failList = false;
  await page.getByRole('button', { name: 'Retry templates' }).click();
  await expect(page.getByLabel('Subject line', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('email-content-mobile.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.locator('iframe')).toBeVisible();
  await page.locator('iframe').scrollIntoViewIfNeeded();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Welcome to Rocento' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('email-templates-mobile.png'), fullPage: true });
});

test('keyboard tabs preserve an unsaved draft and show the current preview', async ({ page }) => {
  const state = await setup(page);
  await page.goto(base);
  await page.getByLabel('Subject line', { exact: true }).fill('An unsaved message for {{brand_name}}');
  const contentTab = page.getByRole('tab', { name: 'Content', exact: true });
  const previewTab = page.getByRole('tab', { name: 'Preview', exact: true });
  const historyTab = page.getByRole('tab', { name: 'Version history', exact: true });
  await contentTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(previewTab).toBeFocused();
  await expect(previewTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Preview', exact: true })).toBeVisible();
  await expect(page.locator('.email-preview-envelope')).toContainText('An unsaved message for Rocento');
  await expect(page.getByLabel('Subject line', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Review & publish', exact: true })).toBeDisabled();
  await previewTab.focus();
  await page.keyboard.press('End');
  await expect(historyTab).toBeFocused();
  await expect(historyTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(contentTab).toBeFocused();
  await expect(page.getByLabel('Subject line', { exact: true })).toHaveValue('An unsaved message for {{brand_name}}');
  expect(state.writes).toEqual([]);
});

test('a failed preview cannot publish the saved draft', async ({ page }) => {
  const state = await setup(page);
  await page.goto(base);
  await saveSubject(page, 'Reviewed subject');
  state.state.failPreview = true;
  await page.getByRole('button', { name: 'Review & publish', exact: true }).click();
  await page.getByLabel('Publication note', { exact: true }).selectOption('Brand voice update');
  await expect(page.getByText('This draft cannot be previewed. Check its variables.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish template', exact: true })).toBeDisabled();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  state.state.failPreview = false;
  await page.getByRole('button', { name: 'Retry preview', exact: true }).click();
  await expect(page.locator('.email-preview-envelope')).toContainText('Reviewed subject');
  await expect(page.getByRole('button', { name: 'Publish template', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Publish template', exact: true }).click();
  await expect(page.getByText('Version 1 is live', { exact: true })).toBeVisible();
});
