import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

type Locale = 'en' | 'ar';
const widths = [320, 360, 390, 430, 768];
const catalog = JSON.parse(readFileSync(new URL('../../apps/storefront/src/interface-messages.json', import.meta.url), 'utf8'));
function demoTheme(store: string) {
  return JSON.parse(readFileSync(new URL(`../../../commerce-demo/${store}/theme.json`, import.meta.url), 'utf8'), (_key, value) =>
    typeof value === 'string' && value.startsWith('asset:') ? null :
    typeof value === 'string' && (value.startsWith('category-link:') || value.startsWith('product-link:')) ? '/search' : value);
}
const bundle = { revision: 1, catalog_version: 'mobile-layout-fixture', overrides: [], messages: catalog.messages.map((message: object) => ({ plural: null, ...message })) };
const names = {
  en: {
    city: 'New Cairo Garden Residential District Extension beside the International Exhibition Center',
    street: 'Building 125, Garden Residential Avenue, International Exhibition Center entrance, New Cairo',
  },
  ar: {
    city: 'امتداد الحي السكني لحدائق القاهرة الجديدة بجوار مركز المعارض والمؤتمرات الدولي',
    street: 'المبنى ١٢٥ شارع الحدائق السكنية بجوار مدخل مركز المعارض والمؤتمرات الدولي بالقاهرة الجديدة',
  },
};
function text(key: string, locale: Locale): string {
  const message = catalog.messages.find((item: { key: string }) => item.key === key);
  if (!message?.[locale]?.other) throw new Error(`Missing fixture phrase: ${key} (${locale})`);
  return message[locale].other;
}

async function mockStore(page: Page, locale: Locale, store: string, signedIn = false) {
  const configuration = demoTheme(store);
  const customer = { id: '11111111-1111-4111-8111-111111111111', email: 'mobile@example.test', verified: true };
  const shortAddress = { id: '22222222-2222-4222-8222-222222222222', label: 'home', formatted_address: '12 Garden Street', latitude: 30.03, longitude: 31.47, is_default: true };
  const longAddress = { ...shortAddress, id: '33333333-3333-4333-8333-333333333333', label: 'work', formatted_address: names[locale].street, is_default: false };
  await page.addInitScript(selectedLocale => localStorage.setItem('commerce-interface-locale', selectedLocale), locale);
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/languages/interface')) return route.fulfill({ json: bundle });
    if (path.endsWith('/languages')) return route.fulfill({ json: { source_locale: 'en', languages: [
      { locale: 'en', name: 'English', native_name: 'English', direction: 'ltr' },
      { locale: 'ar', name: 'Arabic', native_name: 'العربية', direction: 'rtl' },
    ] } });
    if (path.includes('/theme/')) return route.fulfill({ json: { configuration, cities: [] } });
    if (path.includes('/customer/')) {
      if (!signedIn) return route.fulfill({ status: 401, json: { error: 'Sign in required' } });
      if (path.endsWith('/auth/refresh')) return route.fulfill({ json: { customer, access_token: 'mobile-layout-test' } });
      if (path.endsWith('/locations')) return route.fulfill({ json: [shortAddress, longAddress] });
      return route.fulfill({ json: customer });
    }
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { geo_fencing_enabled: false } });
    if (path.endsWith('/delivery-area')) return route.fulfill({ json: { configured: true, deliverable: true, area_id: 'test' } });
    if (path.includes('/content/')) return route.fulfill({ json: null });
    if (path.endsWith('/search')) return route.fulfill({ json: { hits: [], total: 0, facets: {} } });
    if (path.includes('/cart')) return route.fulfill({ json: { id: 'test', items: [], totals: {} } });
    return route.fulfill({ json: [] });
  });
  await page.route('**/data/delivery/eg/index.json', route => route.fulfill({ json: {
    country: { code: 'EG', name: 'Egypt', name_ar: 'مصر' }, state_label: 'Governorate',
    states: [{ code: '11', name: 'Cairo', name_ar: 'القاهرة', city_count: 1 }],
  } }));
  await page.route('**/data/delivery/eg/11.json', route => route.fulfill({ json: [{
    id: '7799991', name: names[locale].city, aliases: ['New Cairo', 'القاهرة الجديدة'], latitude: 30.03, longitude: 31.47, population: 1,
  }] }));
  await page.route('https://*.tile.openstreetmap.org/**', route => route.abort());
}

/** Check components themselves so the shell's overflow clipping cannot hide a failure. */
async function expectContained(page: Page, selectors: string[]) {
  const measurements = await page.locator(selectors.join(',')).evaluateAll(elements => elements
    .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
    .map(element => {
      const rect = element.getBoundingClientRect();
      return { selector: element.className || element.tagName, left: rect.left, right: rect.right, width: rect.width, client: element.clientWidth, scroll: element.scrollWidth, viewport: innerWidth };
    }));
  expect(measurements.length).toBeGreaterThan(0);
  for (const item of measurements) {
    expect(item.width, `${item.selector} must remain visible`).toBeGreaterThan(0);
    expect(item.left, `${item.selector} extends past the viewport start`).toBeGreaterThanOrEqual(-1);
    expect(item.right, `${item.selector} extends past the viewport end`).toBeLessThanOrEqual(item.viewport + 1);
    expect(item.scroll, `${item.selector} has internal horizontal overflow`).toBeLessThanOrEqual(item.client + 1);
  }
}

async function expectDeliveryFormFits(page: Page) {
  await expectContained(page, ['.delivery-screen', '.delivery-screen-grid', '.delivery-panel', '.delivery-step', '.delivery-geography-fields', '.city-select', '.delivery-form-actions']);
  const controls = page.locator('.delivery-screen input:not([type=radio]):not([type=checkbox]), .delivery-screen select');
  const fonts = await controls.evaluateAll(elements => elements.filter(element => element.getClientRects().length)
    .map(element => ({ name: element.getAttribute('aria-label') || element.closest('label')?.textContent?.trim(), fontSize: parseFloat(getComputedStyle(element).fontSize) })));
  expect(fonts.length).toBeGreaterThan(0);
  for (const field of fonts) expect(field.fontSize, `${field.name} must avoid mobile focus zoom`).toBeGreaterThanOrEqual(16);
}

async function chooseArea(page: Page) {
  await page.locator('.delivery-geography-fields select').nth(0).selectOption('EG');
  await page.locator('.delivery-geography-fields select').nth(1).selectOption('11');
  await page.locator('.city-select input').fill('New Cairo');
  await page.locator('.city-select-dropdown [role=option]').first().click();
  await expectDeliveryFormFits(page);
}

async function expectShoppingHeaderFits(page: Page, label: string, locale: Locale) {
  const header = page.locator('.store-header');
  await expect(header).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  await expect(header.locator('.delivery-trigger strong')).toContainText(label);
  await expectContained(page, ['.store-header', '.store-header > nav', '.store-header .brand', '.header-search-zone', '.header-delivery-tools', '.delivery-bar', '.delivery-trigger', '.delivery-trigger > span']);
  const labelBox = await header.locator('.delivery-trigger strong').boundingBox();
  expect(labelBox!.width).toBeGreaterThan(60);
  expect(labelBox!.x).toBeGreaterThanOrEqual(-1);
  expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  const brandImage = header.locator('.brand :is(img, svg)');
  if (await brandImage.count()) expect((await brandImage.first().boundingBox())!.width, 'The mobile logo must remain readable').toBeGreaterThanOrEqual(100);
  await expect(page.locator('.mobile-bottom-nav .cart-link')).toBeVisible();
  for (const selector of ['.brand', '.shopper-language-switcher select', 'button[aria-controls="header-search"]', '.delivery-trigger']) {
    const control = header.locator(selector).first();
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box!.x, `${selector} is clipped at the start`).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width, `${selector} is clipped at the end`).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
  await header.locator('button[aria-controls="header-search"]').click();
  await expect(header.locator('.search-bar')).toBeVisible();
  await expectContained(page, ['.store-header', '.header-search-zone', '.store-search', '.search-bar', '.header-delivery-tools', '.delivery-bar', '.delivery-trigger', '.delivery-trigger > span']);
  await expect(header.locator('.search-bar input')).toBeVisible();
  await expect(header.locator('.search-submit')).toBeVisible();
  for (const selector of ['.search-bar input', '.search-submit']) {
    const box = await header.locator(selector).boundingBox();
    expect(box!.x, `${selector} is clipped at the start`).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width, `${selector} is clipped at the end`).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
  const dimensions = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, body: document.body.scrollWidth, viewport: innerWidth }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
}

for (const store of ['grocery', 'jewelry', 'electronics']) for (const locale of ['en', 'ar'] as const) for (const width of widths) {
  test(`${store} ${locale} ${width}px: choosing an area keeps shopping and search usable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockStore(page, locale, store);
    await page.goto('/delivery-location');
    await chooseArea(page);
    await page.getByRole('button', { name: text('storefront.browse_products_in_this_area', locale), exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('commerce-guest-location')!));
    expect(saved.geography.city_id).toBe('7799991');
    expect(saved.formatted_address).toBe('');
    await expectShoppingHeaderFits(page, names[locale].city, locale);
  });

  test(`${store} ${locale} ${width}px: saving a long guest address keeps shopping and search usable`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await mockStore(page, locale, store);
    await page.goto('/delivery-location');
    await chooseArea(page);
    await page.locator('.delivery-address-step input[maxlength="500"]').fill(names[locale].street);
    await page.getByRole('button', { name: text('storefront.use_this_delivery_address', locale), exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('commerce-guest-location')!));
    expect(saved.formatted_address).toBe(names[locale].street);
    await expectShoppingHeaderFits(page, names[locale].street, locale);
    if (store === 'grocery' && ((locale === 'en' && width === 320) || (locale === 'ar' && width === 390))) {
      await page.locator('.store-header button[aria-controls="header-search"]').click();
      await expect(page.locator('.store-header .search-bar')).not.toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`grocery-${locale}-${width}-selected-address.png`) });
    }
  });

  test(`${store} ${locale} ${width}px: switching to a long saved customer address keeps shopping and search usable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockStore(page, locale, store, true);
    await page.goto('/delivery-location?returnTo=%2Fsearch');
    await expect(page.locator('.saved-address-list input[type=radio]')).toHaveCount(2);
    await page.locator('.saved-address-list input[type=radio]').nth(1).check();
    await page.getByRole('button', { name: text('storefront.use_saved_location', locale), exact: true }).click();
    await expect(page).toHaveURL(/\/search$/);
    await expectShoppingHeaderFits(page, names[locale].street, locale);
  });
}


test('browsing a neighborhood requires a real street before saving a delivery address', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockStore(page, 'en', 'grocery');
  await page.goto('/delivery-location');
  await chooseArea(page);
  await page.getByRole('button', { name: 'Browse products in this area', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator('.store-header .delivery-trigger').click();
  const street = page.getByRole('textbox', { name: 'Street address', exact: true });
  await expect(street).toHaveValue('');
  await page.getByRole('button', { name: 'Use this delivery address', exact: true }).click();
  await expect(page).toHaveURL(/delivery-location/);
  expect(await street.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true);
  await street.fill('125 Garden Street');
  await page.getByRole('button', { name: 'Use this delivery address', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.store-header .delivery-trigger')).toContainText('125 Garden Street');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('commerce-guest-location')!).formatted_address)).toBe('125 Garden Street');
});
