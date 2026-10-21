import { test, expect, type Page } from '@playwright/test';
import type { FulfillmentCapabilities, FulfillmentSettings, InventorySource } from '../../packages/api-client/src/index';

const sourceId = '00000000-0000-4000-8000-000000000010';
const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const third = '00000000-0000-4000-8000-000000000003';
const path = `/catalog/sources/${sourceId}`;
const pickupPermissions = ['inventory.read', 'fulfillment.settings.view', 'fulfillment.settings.manage', 'fulfillment.pickup.manage'];
const caps: FulfillmentCapabilities = {
  delivery_enabled: true, pickup_enabled: true, scheduled_delivery_enabled: false, asap_delivery_enabled: true,
  capacity_management_enabled: false, checkout_capacity_holds_enabled: false, geo_fencing_enabled: false, global_delivery_enabled: false,
  multi_source_fulfillment_enabled: false, split_order_scheduling_enabled: false, automatic_source_routing_enabled: true,
  customer_delivery_slot_selection_enabled: false, admin_manual_scheduling_enabled: true, pickup_scheduling_enabled: false,
  split_delivery_mode: 'same_window_required', delivery_city_ids: [],
};
async function setup(page: Page, permissions = ['*']) {
  let location: InventorySource = { id: sourceId, code: 'cairo', name: 'Cairo warehouse', is_enabled: true, address: 'Cairo', latitude: null, longitude: null, contact_name: '', contact_phone: '', priority: 0 };
  const settings: FulfillmentSettings = {
    system: {}, stores: [
      { id: first, name: 'Main store', overrides: {}, resolved: caps },
      { id: second, name: 'Second store', overrides: {}, resolved: { ...caps, pickup_enabled: false } },
      { id: third, name: 'New store', overrides: {}, resolved: caps },
    ], locations: [{ id: sourceId, name: location.name }], sources: [
      { store_id: first, source_id: sourceId, pickup_enabled: true, pickup_instructions: 'Main entrance', preparation_minutes: 30 },
      { store_id: second, source_id: sourceId, pickup_enabled: true, pickup_instructions: 'Side entrance', preparation_minutes: 60 },
    ],
  };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const requests: string[] = [];
  let failLoad = false, failSave = false;
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push(url.pathname);
    if (url.pathname.endsWith('/admin/me')) return route.fulfill({ json: { user: { id: first, name: 'Pickup operator', email: 'operator@example.test' }, permissions } });
    if (url.pathname.endsWith('/fulfillment/capabilities')) return failLoad ? route.fulfill({ status: 503, json: { error: 'Pickup service unavailable' } }) : route.fulfill({ json: settings });
    if (['POST', 'PUT'].includes(request.method())) {
      const body = request.postDataJSON(); writes.push({ path: url.pathname, body });
      if (url.pathname.endsWith('/store-sources')) {
        if (failSave) return route.fulfill({ status: 503, json: { error: 'Could not save pickup' } });
        const connection = { ...body };
        delete connection.reason;
        settings.sources = [...settings.sources.filter(item => item.store_id !== body.store_id || item.source_id !== body.source_id), connection];
        return route.fulfill({ json: { status: 'ok' } });
      }
      if (url.pathname.includes('/inventory/sources')) {
        location = { ...location, ...body };
        return route.fulfill({ json: location });
      }
    }
    if (url.pathname.endsWith('/inventory/sources')) return route.fulfill({ json: [location] });
    if (url.pathname.includes('/grids/')) return route.fulfill({ json: { items: [location], total_count: 1, next_cursor: null } });
    if (url.pathname.endsWith('/sorts')) return route.fulfill({ json: ['id'] });
    return route.fulfill({ json: [] });
  });
  await page.route('https://*.tile.openstreetmap.org/**', route => route.abort());
  return { writes, requests, settings, failLoad: (value: boolean) => { failLoad = value; }, failSave: (value: boolean) => { failSave = value; } };
}
const pickup = (page: Page) => page.getByRole('region', { name: 'Store pickup', exact: true });
async function reason(page: Page) { await pickup(page).getByLabel('Location change reason', { exact: true }).selectOption('Pickup instructions update'); }

test('store-scoped location links preserve pickup configuration while the store is off', async ({ page }) => {
  const state = await setup(page);
  await page.goto(`/system/configuration/fulfillment?store=${second}`);
  await page.getByRole('button', { name: /04 Store locations/ }).click();
  await expect(page.getByLabel('Pickup instructions')).toHaveCount(0);
  await page.getByRole('link', { name: 'Manage location', exact: true }).click();
  await expect(page).toHaveURL(`${path}?store=${second}`);
  await expect(pickup(page).getByLabel('Store for pickup')).toHaveValue(second);
  await expect(pickup(page).getByRole('switch')).toBeChecked();
  await expect(pickup(page).getByRole('switch')).toBeDisabled();
  await pickup(page).getByLabel('Pickup instructions').fill('Collect from the rear desk');
  await reason(page);
  await pickup(page).getByRole('button', { name: 'Save pickup settings', exact: true }).click();
  await expect(pickup(page).getByRole('status')).toContainText('Pickup settings saved for Second store.');
  expect(state.writes).toEqual([{ path: '/api/v1/admin/fulfillment/store-sources', body: { store_id: second, source_id: sourceId, pickup_enabled: true, pickup_instructions: 'Collect from the rear desk', preparation_minutes: 60, reason: 'Pickup instructions update' } }]);
  expect(state.settings.sources.find(item => item.store_id === first)?.pickup_instructions).toBe('Main entrance');
  await page.reload();
  await expect(pickup(page).getByLabel('Pickup instructions')).toHaveValue('Collect from the rear desk');
  await pickup(page).getByRole('link', { name: 'Manage store policy' }).click();
  await expect(page.getByRole('switch', { name: 'Store pickup', exact: true })).not.toBeChecked();
});

test('pickup operators do not need inventory write permission', async ({ page }) => {
  const state = await setup(page, pickupPermissions);
  await page.goto(`${path}?store=${first}`);
  await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save inventory location', exact: true })).toHaveCount(0);
  await pickup(page).getByLabel('Pickup instructions').fill('Reception'); await reason(page);
  await pickup(page).getByRole('button', { name: 'Save pickup settings', exact: true }).click();
  await expect(pickup(page).getByRole('status')).toContainText('Pickup settings saved');
  expect(state.writes).toHaveLength(1);
});

for (const missing of ['fulfillment.settings.view', 'fulfillment.settings.manage', 'fulfillment.pickup.manage']) test(`pickup respects missing ${missing}`, async ({ page }) => {
  const state = await setup(page, pickupPermissions.filter(permission => permission !== missing));
  await page.goto(`${path}?store=${first}`);
  await expect(page.getByRole('heading', { name: 'Location details', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Save pickup|Connect store and save/ })).toHaveCount(0);
  if (missing.endsWith('.view')) expect(state.requests).not.toContain('/api/v1/admin/fulfillment/capabilities');
  else await expect(pickup(page).getByLabel('Pickup instructions')).toBeDisabled();
  expect(state.writes).toEqual([]);
});

test('store switching and navigation protect drafts and each save preserves the other form', async ({ page }) => {
  const state = await setup(page);
  await page.goto(`${path}?store=${first}`);
  await pickup(page).getByLabel('Pickup instructions').fill('Keep my pickup draft');
  page.once('dialog', dialog => dialog.dismiss());
  await pickup(page).getByLabel('Store for pickup').selectOption(second);
  await expect(pickup(page).getByLabel('Store for pickup')).toHaveValue(first);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('link', { name: 'Back to inventory locations', exact: true }).click();
  await expect(page).toHaveURL(`${path}?store=${first}`);
  await page.getByLabel('Name', { exact: true }).fill('Renamed warehouse');
  await page.getByRole('button', { name: 'Save inventory location', exact: true }).click();
  await expect(page.getByText('Inventory location saved.', { exact: true })).toBeVisible();
  await expect(pickup(page).getByLabel('Pickup instructions')).toHaveValue('Keep my pickup draft');
  await page.getByLabel('Name', { exact: true }).fill('Unsaved location name');
  await reason(page); await pickup(page).getByRole('button', { name: 'Save pickup settings', exact: true }).click();
  await expect(pickup(page).getByRole('status')).toContainText('Pickup settings saved');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('link', { name: 'Back to inventory locations', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved location name');
  expect(state.writes).toHaveLength(2);
});

test('new locations are saved before store connections and opening shared locations requires a store choice', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/catalog/sources/new');
  await expect(page.getByText('Save this inventory location first, then connect stores and configure pickup.')).toBeVisible();
  await page.getByLabel('Code', { exact: true }).fill('new-branch');
  await page.getByLabel('Name', { exact: true }).fill('New branch');
  await page.getByRole('button', { name: 'Save inventory location', exact: true }).click();
  await expect(page).toHaveURL(path);
  await expect(pickup(page).getByLabel('Store for pickup')).toHaveValue('');
  await expect(pickup(page).getByLabel('Pickup instructions')).toHaveCount(0);
  await pickup(page).getByLabel('Store for pickup').selectOption(third);
  await pickup(page).getByRole('switch').check(); await reason(page);
  await pickup(page).getByRole('button', { name: 'Connect store and save pickup' }).click();
  await expect(pickup(page).getByRole('status')).toContainText('Pickup settings saved for New store.');
  expect(state.settings.sources.filter(item => item.store_id === third)).toHaveLength(1);
});

test('load failures, invalid inputs, and failed writes never report a successful save or lose the draft', async ({ page }) => {
  const state = await setup(page); state.failLoad(true);
  await page.goto(`${path}?store=${first}`);
  await expect(pickup(page).getByRole('button', { name: 'Retry pickup settings' })).toBeVisible();
  state.failLoad(false); await pickup(page).getByRole('button', { name: 'Retry pickup settings' }).click();
  await pickup(page).getByLabel('Pickup instructions').fill('Keep this after failure'); await reason(page);
  for (const value of ['0', '1441', '1.5', '']) {
    await pickup(page).getByLabel('Preparation time (minutes)').fill(value);
    await expect(pickup(page).getByRole('button', { name: 'Save pickup settings', exact: true })).toBeDisabled();
  }
  await pickup(page).getByLabel('Preparation time (minutes)').fill('45'); state.failSave(true);
  await pickup(page).getByRole('button', { name: 'Save pickup settings', exact: true }).click();
  await expect(pickup(page).getByRole('alert')).toContainText('Could not save pickup');
  await expect(pickup(page).getByLabel('Pickup instructions')).toHaveValue('Keep this after failure');
  await expect(pickup(page).getByRole('status')).toHaveCount(0);
  state.failSave(false); await pickup(page).getByRole('button', { name: 'Save pickup settings', exact: true }).click();
  await expect(pickup(page).getByRole('status')).toContainText('Pickup settings saved');
});

test('unknown store links do not fall back to another store, and missing locations cannot be configured', async ({ page }) => {
  const state = await setup(page);
  await page.goto(`${path}?store=missing`);
  await expect(pickup(page).getByRole('alert')).toContainText('requested store is unavailable');
  await expect(pickup(page).getByLabel('Pickup instructions')).toHaveCount(0);
  await page.goto('/catalog/sources/unknown');
  await expect(page.getByRole('alert')).toContainText('Inventory location not found');
  await expect(pickup(page)).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('pickup controls fit desktop, tablet and mobile layouts', async ({ page }, info) => {
  await setup(page);
  await page.goto(`${path}?store=${first}`);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await pickup(page).scrollIntoViewIfNeeded();
    await expect(pickup(page).getByLabel('Store for pickup')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await pickup(page).screenshot({ path: info.outputPath(`location-pickup-${width}.png`) });
  }
});


test('refreshed connection changes cannot overwrite another operator without review', async ({ page }) => {
  const state = await setup(page);
  await page.goto(`${path}?store=${first}`);
  await pickup(page).getByLabel('Pickup instructions').fill('Local draft'); await reason(page);
  state.settings.sources[0].pickup_instructions = 'Changed by another operator';
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(pickup(page).getByRole('alert')).toContainText('changed since you opened');
  await expect(pickup(page).getByRole('button', { name: 'Save pickup settings', exact: true })).toBeDisabled();
  await expect(pickup(page).getByLabel('Pickup instructions')).toHaveValue('Local draft');
  page.once('dialog', dialog => dialog.accept());
  await pickup(page).getByRole('button', { name: 'Reload latest pickup settings' }).click();
  await expect(pickup(page).getByLabel('Pickup instructions')).toHaveValue('Changed by another operator');
  expect(state.writes).toEqual([]);
});

test('a fresh pickup draft is guarded after saving and discarding a store switch clears only pickup changes', async ({ page }) => {
  await setup(page);
  await page.goto(`${path}?store=${first}`);
  await pickup(page).getByLabel('Pickup instructions').fill('Saved instructions'); await reason(page);
  await pickup(page).getByRole('button', { name: 'Save pickup settings', exact: true }).click();
  await expect(pickup(page).getByRole('status')).toContainText('Pickup settings saved');
  await pickup(page).getByLabel('Pickup instructions').fill('New unsaved draft');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('link', { name: 'Back to inventory locations', exact: true }).click();
  await expect(pickup(page).getByLabel('Pickup instructions')).toHaveValue('New unsaved draft');
  await page.getByLabel('Name', { exact: true }).fill('Unsaved warehouse name');
  page.once('dialog', dialog => dialog.accept());
  await pickup(page).getByLabel('Store for pickup').selectOption(second);
  await expect(pickup(page).getByLabel('Pickup instructions')).toHaveValue('Side entrance');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved warehouse name');
});
