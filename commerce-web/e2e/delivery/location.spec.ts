import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
function demoTheme(store: string) {
  // The demo seeder resolves these references before publishing the preset.
  return JSON.parse(readFileSync(new URL(`../../../commerce-demo/${store}/theme.json`, import.meta.url), 'utf8'), (_key, value) =>
    typeof value === 'string' && value.startsWith('asset:') ? null :
    typeof value === 'string' && (value.startsWith('category-link:') || value.startsWith('product-link:')) ? '/search' : value);
}
async function mockStore(page: Page) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/languages')) return route.fulfill({ json: { source_locale: 'en', languages: [] } });
    if (path.includes('/theme/')) return route.fulfill({ json: { configuration: theme, cities: [] } });
    if (path.includes('/customer/')) return route.fulfill({ status: 401, json: { error: 'Sign in required' } });
    if (path.endsWith('/delivery-area')) return route.fulfill({ json: { configured: true, deliverable: true, area_id: 'test' } });
    if (path.includes('/content/')) return route.fulfill({ json: null });
    if (path.endsWith('/search')) return route.fulfill({ json: { hits: [], total: 0, facets: {} } });
    if (path.includes('/cart')) return route.fulfill({ json: { id: 'test', items: [], totals: {} } });
    return route.fulfill({ json: [] });
  });
  await page.route('https://*.tile.openstreetmap.org/**', route => route.abort());
}

test('saved delivery addresses are selectable cards and return to shopping', async ({ page }) => {
  await mockStore(page);
  const customer = { id: '11111111-1111-4111-8111-111111111111', email: 'test@example.test', verified: true };
  const address = { id: '22222222-2222-4222-8222-222222222222', label: 'home', formatted_address: '12 Garden Street', latitude: 30.03, longitude: 31.47, is_default: true };
  await page.route('**/api/**/customer/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/refresh')) return route.fulfill({ json: { customer, access_token: 'test' } });
    if (path.endsWith('/locations')) return route.fulfill({ json: [address, { ...address, id: '33333333-3333-4333-8333-333333333333', label: 'work', formatted_address: 'Office Avenue', is_default: false }] });
    return route.fulfill({ json: customer });
  });
  await page.goto('/delivery-location?returnTo=%2Fsearch');
  const cards = page.getByRole('group', { name: 'Saved addresses' });
  await expect(cards.getByRole('radio')).toHaveCount(2);
  await cards.getByRole('radio', { name: /Office Avenue/ }).check();
  await page.getByRole('button', { name: 'Use saved location', exact: true }).click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.locator('.delivery-trigger').first()).toContainText('Office Avenue');
});

for (const store of ['grocery', 'jewelry', 'electronics']) test(`${store}: delivery page stays contained on desktop and mobile`, async ({ page }, info) => {
  await mockStore(page);
  const configuration = demoTheme(store);
  await page.route('**/api/**/theme/**', route => route.fulfill({ json: { configuration, cities: [] } }));
  await page.goto('/delivery-location');
  await expect(page.getByRole('heading', { name: 'Where should we deliver?' })).toBeVisible();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const box = await page.locator('.delivery-screen').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(width <= 640 ? 16 : 32);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width - (width <= 640 ? 16 : 32));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440) await page.screenshot({ path: info.outputPath(`${store}-delivery-desktop.png`) });
  }
});

for (const store of ['grocery', 'jewelry', 'electronics']) test(`${store}: mobile navigation and category sorting`, async ({ page }, info) => {
  await mockStore(page);
  const configuration = demoTheme(store);
  await page.route('**/api/**/theme/**', route => route.fulfill({ json: { configuration, cities: [] } }));
  const category = { id: '44444444-4444-4444-8444-444444444444', name: 'Collection', slug: 'collection', parent_id: null };
  await page.route('**/api/catalog/categories', route => route.fulfill({ json: [category] }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/categories/${category.id}?stock=true&offset=24`);
  const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link')).toHaveCount(4);
  await expect(nav.getByRole('link', { name: 'Shop', exact: true })).toHaveAttribute('aria-current', 'page');
  const sort = page.getByLabel('Sort products', { exact: true });
  await sort.selectOption('price:desc');
  await expect(page).toHaveURL(/sort_by=price/);
  expect(new URL(page.url()).searchParams.get('stock')).toBe('true');
  expect(new URL(page.url()).searchParams.has('offset')).toBe(false);
  await sort.selectOption('name:asc');
  await page.goBack();
  await expect(sort).toHaveValue('price:desc');
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${store}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(nav).not.toBeVisible();
});

test('dependent dropdowns, alternate pin method, and a saved neighborhood without a map pin', async ({ page }, info) => {
  await mockStore(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/delivery-location');
  const area = page.getByRole('radio', { name: /Choose your neighborhood/ });
  const pin = page.getByRole('radio', { name: /Pin your building entrance/ });
  const country = page.getByLabel('Country', { exact: true });
  const state = page.getByRole('combobox', { name: /^(State \/ Region|Governorate)$/ });
  const city = page.getByLabel('City / Town / Neighborhood', { exact: true });
  await expect(pin).toBeChecked();
  await expect(page.getByLabel('Delivery location map', { exact: true })).toBeVisible();
  await area.check();
  await expect(page.getByLabel('Delivery location map', { exact: true })).toHaveCount(0);
  await expect(state).toBeDisabled();
  await expect(city).toBeDisabled();
  await country.selectOption('EG');
  await expect(state.locator('option')).toHaveCount(28);
  await state.selectOption('11');
  await expect(city).toBeEnabled();
  await city.fill('New Cairo');
  await page.getByRole('option', { name: 'New Cairo', exact: true }).click();
  await expect(page.getByText('New Cairo, Cairo, Egypt', { exact: true })).toBeVisible();
  await state.selectOption('06');
  await expect(city).toHaveValue('');
  await city.click();
  await expect(page.getByRole('option', { name: 'New Cairo', exact: true })).toHaveCount(0);
  await city.fill('Alexandria');
  await page.getByRole('option', { name: 'Alexandria', exact: true }).click();
  await country.selectOption('');
  await expect(state).toHaveValue('');
  await expect(city).toHaveValue('');
  await expect(city).toBeDisabled();
  await pin.check();
  await expect(area).not.toBeChecked();
  await expect(country).toHaveCount(0);
  await expect(page.getByLabel('Delivery location map', { exact: true })).toBeVisible();
  await page.getByText('Enter map coordinates manually', { exact: true }).click();
  await page.getByLabel('Latitude', { exact: true }).fill('30.03');
  await page.getByLabel('Longitude', { exact: true }).fill('31.47');
  await area.check();
  await expect(page.getByLabel('Delivery location map', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Latitude', { exact: true })).toHaveCount(0);
  await expect(country).toHaveValue('');
  await country.selectOption('EG');
  await state.selectOption('11');
  await city.fill('القاهرة الجديدة');
  await page.getByRole('option', { name: 'New Cairo', exact: true }).click();
  await page.getByLabel('Street address', { exact: true }).fill('12 Test Street');
  await page.screenshot({ path: info.outputPath('delivery-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Use this delivery address', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5188/');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('commerce-guest-location')!));
  expect(saved.location_method).toBe('neighborhood');
  expect(saved.geography).toMatchObject({ country_code: 'EG', state_code: '11', city_id: '7799991' });
  expect(saved.formatted_address).toBe('12 Test Street');
  await page.goto('/delivery-location');
  await expect(area).toBeChecked();
  await expect(city).toHaveValue('New Cairo');
  await expect(page.getByLabel('Delivery location map', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('mobile layout and recoverable city directory failure', async ({ page }, info) => {
  await mockStore(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/data/delivery/eg/11.json', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/delivery-location');
  await page.getByRole('radio', { name: /Choose your neighborhood/ }).check();
  await page.getByLabel('Country', { exact: true }).selectOption('EG');
  await page.getByRole('combobox', { name: /^(State \/ Region|Governorate)$/ }).selectOption('11');
  await expect(page.getByRole('alert').filter({ hasText: 'The location list could not be loaded' })).toContainText('The location list could not be loaded');
  await expect(page.getByLabel('City / Town / Neighborhood', { exact: true })).toBeDisabled();
  await page.unroute('**/data/delivery/eg/11.json');
  await page.getByRole('button', { name: 'Retry location list' }).click();
  await page.getByLabel('City / Town / Neighborhood', { exact: true }).fill('New Cairo');
  await page.getByRole('option', { name: 'New Cairo', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('delivery-mobile.png'), fullPage: true });
});


test('pin method saves independently of the location directory', async ({ page }) => {
  await mockStore(page);
  await page.route('**/data/delivery/eg/index.json', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/delivery-location');
  await page.getByRole('radio', { name: /Pin your building entrance/ }).check();
  await expect(page.getByLabel('Country', { exact: true })).toHaveCount(0);
  await page.getByText('Enter map coordinates manually', { exact: true }).click();
  await page.getByLabel('Latitude', { exact: true }).fill('30.05');
  await page.getByLabel('Longitude', { exact: true }).fill('31.24');
  await page.getByLabel('Street address', { exact: true }).fill('12 Entrance Street');
  await page.getByRole('button', { name: 'Use this delivery address', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5188/');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('commerce-guest-location')!));
  expect(saved.location_method).toBe('pin');
  expect(saved.geography).toBeNull();
  expect(saved.latitude).toBe(30.05);
  await page.goto('/delivery-location');
  await expect(page.getByRole('radio', { name: /Pin your building entrance/ })).toBeChecked();
  await expect(page.getByLabel('Delivery location map', { exact: true })).toBeVisible();
});

test('searchable city dropdown supports keyboard choice and rejects unselected text', async ({ page }) => {
  await mockStore(page);
  await page.goto('/delivery-location');
  await page.getByRole('radio', { name: /Choose your neighborhood/ }).check();
  await page.getByLabel('Country', { exact: true }).selectOption('EG');
  await page.getByRole('combobox', { name: /^(State \/ Region|Governorate)$/ }).selectOption('11');
  const city = page.getByRole('combobox', { name: 'City / Town / Neighborhood', exact: true });
  await city.fill('القاهرة الجديدة');
  await expect(page.getByRole('option', { name: 'New Cairo', exact: true })).toBeVisible();
  await city.press('ArrowDown');
  await city.press('Enter');
  await expect(city).toHaveValue('New Cairo');
  await expect(city).toHaveAttribute('aria-expanded', 'false');
  expect(await city.evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(true);
  await city.fill('Not a real neighborhood');
  await expect(page.getByText('No matching locations', { exact: true })).toBeVisible();
  expect(await city.evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(false);
  await city.press('Escape');
  await expect(city).toHaveAttribute('aria-expanded', 'false');
});


test('international directory switches countries without retaining another region or city', async ({ page }) => {
  await mockStore(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/delivery-location');
  await page.getByRole('radio', { name: /Choose your neighborhood/ }).check();
  const country = page.getByLabel('Country', { exact: true });
  const city = page.getByLabel('City / Town / Neighborhood', { exact: true });
  await expect(country.locator('option')).toHaveCount(7);
  for (const code of ['SA', 'KW', 'US', 'NL', 'GB']) {
    const manifest = JSON.parse(readFileSync(new URL(`../../apps/storefront/public/data/delivery/${code.toLowerCase()}/index.json`, import.meta.url), 'utf8'));
    await country.selectOption(code);
    await expect(city).toHaveValue('');
    const state = page.getByRole('combobox', { name: manifest.state_label, exact: true });
    await expect(state).toHaveValue('');
    await expect(state.locator('option')).toHaveCount(manifest.states.length + 1);
    await state.selectOption(manifest.states[0].code);
    await expect(city).toBeEnabled();
    await city.click();
    const options = page.getByRole('listbox', { name: 'Cities and neighborhoods' }).getByRole('option');
    expect(await options.count()).toBeLessThanOrEqual(60);
    await options.first().click();
    await expect(city).not.toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByLabel('Street address', { exact: true }).fill('12 Test Street');
  await page.getByRole('button', { name: 'Use this delivery address', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5188/');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('commerce-guest-location')!));
  expect(saved.geography.country_code).toBe('GB');
  expect(saved.geography.state_code).toBe('ENG');
});
