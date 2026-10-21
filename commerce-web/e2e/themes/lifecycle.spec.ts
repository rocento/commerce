import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { ThemeConfiguration } from '../../packages/api-client/src/themes';

const contract = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8'));
const defaultTheme = (): ThemeConfiguration => structuredClone(contract.default);

const storefront = process.env.STOREFRONT_BASE_URL || 'http://127.0.0.1:5173';

test('theme draft, secure preview, validation, immutable publication, rollback and duplicate', async ({ page, context }, info) => {
  const runtime: string[] = [];
  page.on('pageerror', error => runtime.push(error.message));
  const before = await context.request.get(`${storefront}/api/v1/theme/storefront`);
  expect(before.ok()).toBeTruthy();
  const liveBefore = await before.json();
  await page.goto('/content/themes');
  await page.getByLabel('Theme name', { exact: true }).fill(`Theme regression ${Date.now()}`);
  await page.getByRole('button', { name: 'Create theme', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to themes' })).toBeVisible();
  await page.getByRole('tab', { name: 'Sections', exact: true }).focus();
  for (const name of ['Translations', 'Fonts', 'Tokens']) {
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name, exact: true })).toBeFocused();
  }
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'theme-tab-tokens');
  await page.keyboard.press('Home');
  await page.locator('summary').filter({ hasText: /^Hero/ }).click();
  await page.locator('details[open]').getByLabel('heading', { exact: true }).fill('Regression collection');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(page.getByText('Theme validation passed.', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('editor-desktop.png'), fullPage: true });

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  const preview = page.frameLocator('iframe');
  await expect(preview.getByRole('heading', { name: 'Regression collection', exact: true })).toBeVisible();
  await expect(preview.getByText('Draft preview', { exact: true })).toBeVisible();
  const previewURL = await page.locator('iframe').getAttribute('src');
  const id = new URL(previewURL!).searchParams.get('theme_preview')!;
  const saved = await (await context.request.get(`/api/v1/admin/themes/${id}`)).json();
  const conflict = await context.request.put(`/api/v1/admin/themes/${id}`, {
    headers: { 'X-Commerce-Request': '1' },
    data: { expected_revision: saved.revision - 1, configuration: saved.configuration },
  });
  expect(conflict.status()).toBe(409);

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm publication' }).click();
  await expect(page.getByText('New version published.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(page.getByText('V1 · Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for version 1', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rollback', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm publication' }).click();
  await expect(page.getByText('V2 · Live', { exact: true })).toBeVisible();
  const versions = await (await context.request.get(`/api/v1/admin/themes/${id}/versions`)).json();
  expect(versions).toHaveLength(2);
  expect(versions[0].source_version).toBe(versions[1].id);
  expect(versions[0].configuration).toEqual(versions[1].configuration);
  const historical = await context.request.get(`/api/v1/admin/themes/${id}/versions/${versions[1].id}`);
  expect(historical.ok()).toBeTruthy();
  expect((await historical.json()).number).toBe(1);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByText('Theme duplicated.', { exact: true })).toBeVisible();
  const liveAfter = await (await context.request.get(`${storefront}/api/v1/theme/storefront`)).json();
  expect(liveAfter).toEqual(liveBefore);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('editor-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(runtime).toEqual([]);
});

test('anonymous visitors cannot load unpublished previews or management APIs', async ({ browser }) => {
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await anonymous.newPage();
    const id = '11111111-1111-4111-8111-111111111111';
    await page.goto(`${storefront}/?theme_preview=${id}`);
    await expect(page.getByRole('heading', { name: 'Preview unavailable' })).toBeVisible();
    for (const path of ['themes', `themes/${id}/preview`, `themes/${id}/versions`]) {
      const response = await anonymous.request.get(`${storefront}/api/v1/admin/${path}`);
      expect(response.status()).toBe(403);
      expect(response.headers()['cache-control']).toBe('no-store');
    }
  } finally { await anonymous.close(); }
});

for (const width of [390, 1440]) {
  test(`reference storefront renders assets and commerce routes at ${width}px`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.route('**/api/v1/theme/*', route => route.fulfill({ json: { version_id: null, configuration: defaultTheme() } }));
    await page.goto(storefront);
    await expect(page.getByRole('heading', { name: 'Good food. Everyday.' })).toBeVisible();
    await expect(page.locator('.theme-hero img')).toBeVisible();
    const hero = (await page.locator('.theme-hero').boundingBox())!;
    expect(hero.x).toBeGreaterThan(0);
    expect(hero.width).toBeLessThan(width);
    expect(Math.abs(hero.x - (width - hero.width) / 2)).toBeLessThan(1);
    await page.locator('.theme-hero img').evaluate((img: HTMLImageElement) => img.decode());
    expect(await page.locator('.theme-hero img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('.theme-grid .product-card').first()).toBeVisible();
    await expect(page.locator('.theme-category-grid a').first()).toBeVisible();
    const productPath = await page.locator('.theme-grid .product-card').first().locator('a[href^="/products/"]').first().getAttribute('href');
    const categoryPath = await page.locator('.theme-category-grid a').first().getAttribute('href');
    await page.screenshot({ path: info.outputPath(`storefront-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.theme-hero').getByRole('link', { name: 'Shop now' }).click();
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.locator('.theme-page main')).toBeVisible();
    await page.goto(`${storefront}${categoryPath}`);
    await expect(page.locator('.theme-page main h1')).toBeVisible();
    await page.goto(`${storefront}${productPath}`);
    await expect(page.locator('.theme-page main h1')).toBeVisible();
    await page.goto(`${storefront}/cart`);
    await expect(page.locator('.theme-page main')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('disabled sections, token changes and malformed configuration fail safely', async ({ page }) => {
  const config = defaultTheme();
  config.pages.home[0].enabled = false;
  config.tokens['color.primary'] = '#ffff00';
  await page.route('**/api/v1/theme/*', route => route.fulfill({ json: { version_id: null, configuration: config } }));
  await page.goto(storefront);
  await expect(page.locator('.theme-hero')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Commerce' })).toBeVisible();
  await expect(page.locator('.theme-announcement')).toHaveCSS('background-color', 'rgb(255, 255, 0)');
  await expect(page.locator('.theme-announcement')).toHaveCSS('color', 'rgb(0, 0, 0)');
  await page.route('**/api/v1/theme/*', route => route.fulfill({ json: { configuration: { ...config, pages: { ...config.pages, home: [null] } } } }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Storefront unavailable', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('We could not load this storefront.');
  await expect(page.locator('.theme-hero')).toHaveCount(0);
  await page.unroute('**/api/v1/theme/*');
  await page.route('**/api/v1/theme/*', route => route.fulfill({ json: { configuration: defaultTheme() } }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Good food. Everyday.', exact: true })).toBeVisible();
  await expect(page.locator('.theme-announcement')).toHaveCSS('background-color', 'rgb(20, 108, 67)');
});
