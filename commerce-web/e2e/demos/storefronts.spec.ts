import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const jewelry = process.env.JEWELRY_BASE_URL || 'http://localhost:5273';
const grocery = process.env.GROCERY_BASE_URL || 'http://localhost:5173';
const contract = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8'));

for (const width of [390, 1440]) {
  test(`Jewelry renders configured imagery and shared screens at ${width}px`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(jewelry);
    await expect(page.getByRole('heading', { name: 'A little beauty. A lasting feeling.' })).toBeVisible();
    await expect(page.locator('.store-shell')).toHaveAttribute('data-presentation', 'heritage');
    await expect(page.getByText('Account service unavailable. Please reload to try again.')).toHaveCount(0);
    await expect(page.locator('.theme-category-showcase img')).toHaveCount(4);
    await expect(page.locator('.theme-grid .product-card')).toHaveCount(6);
    await page.locator('.theme-editorial-hero img').evaluate((img: HTMLImageElement) => img.decode());
    await expect(page.locator('.theme-editorial-hero h1')).toHaveCSS('font-family', /Futura Now Headline/);
    await expect(page.locator('.store-header').getByRole('link', { name: 'Rocento home' })).toBeVisible();
    await expect(page.locator('.store-header').getByRole('link', { name: 'Assistant', exact: true })).toBeVisible();
    await page.locator('button[aria-controls=header-search]').click();
    await expect(page.locator('#header-search')).toBeVisible();
    await page.locator('button[aria-controls=header-search]').click();
    await expect(page.locator('#header-search')).toBeHidden();
    expect(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px "Futura Now Headline"'); })).toBe(true);
    await expect(page.locator('.store-header')).toHaveCSS('background-color', 'rgb(8, 48, 87)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`jewelry-${width}.png`), fullPage: true });
    await page.getByRole('link', { name: 'Explore the collection' }).click();
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.locator('.product-card').first()).toBeVisible();
    await page.locator('.category-nav').getByRole('link', { name: 'Rings', exact: true }).click();
    await expect(page).toHaveURL(/\/categories\//);
    await expect(page.locator('.product-card').first()).toBeVisible();
    await page.locator('.product-card').filter({ hasText: 'The Solitaire Ring' }).click();
    await expect(page.getByRole('heading', { name: 'The Solitaire Ring', exact: true, level: 1 })).toBeVisible();
    await page.getByLabel('Choose variant').selectOption({ label: 'US 7 — $249.00' });
    await expect(page.getByRole('heading', { name: 'US 7', exact: true })).toBeVisible();
    await expect(page.locator('.detail-image img')).toBeVisible();
    await expect(page.locator('.buy-box').getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
    await page.getByText('Customer care', { exact: true }).click();
    await expect(page.getByRole('link', { name: 'Ask our assistant', exact: true })).toBeVisible();
    await page.getByText('Customer care', { exact: true }).click();
    const gallery = await page.locator('.product-media-panel').boundingBox();
    const buyBox = await page.locator('.buy-box').boundingBox();
    if (width === 1440) expect(buyBox!.x).toBeGreaterThan(gallery!.x + gallery!.width);
    else expect(buyBox!.y).toBeGreaterThan(gallery!.y + gallery!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`product-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
    await expect(page.getByText('Added to your cart. Stock is reserved for a limited time.')).toBeVisible();
    await page.getByRole('link', { name: 'View your cart →' }).click();
    await expect(page.locator('.cart-line')).toHaveCount(1);
    await expect(page.locator('.cart-line')).toContainText('Gold Solitaire Ring');
    // Release this test's reservation before leaving its isolated guest cart.
    await page.locator('.cart-line').getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.cart-line')).toHaveCount(0);
    for (const path of ['/cart', '/login', '/register', '/checkout', '/account']) {
      await page.goto(jewelry + path);
      if (path === '/checkout') await expect(page.locator('.store-header')).toHaveCount(0);
      else await expect(page.locator('.store-header')).toBeVisible();
      await expect(page.locator('.store-shell')).toHaveAttribute('data-presentation', 'heritage');
      await expect(page.getByText('This section is temporarily unavailable.')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}

test('Grocery retains its own theme and catalog; invalid themes still fall back', async ({ page, request }, info) => {
  const [g, j] = await Promise.all([request.get(grocery + '/api/v1/theme/storefront'), request.get(jewelry + '/api/v1/theme/storefront')]);
  expect(g.ok()).toBeTruthy();expect(j.ok()).toBeTruthy();
  const gtheme = (await g.json()).configuration;const jtheme = (await j.json()).configuration;
  expect(gtheme).toEqual(contract.default);expect(jtheme.tokens['font.heading']).toBe('Futura Now Headline');
  const [gc, jc] = await Promise.all([request.get(grocery + '/api/v1/catalog/categories'),request.get(jewelry + '/api/v1/catalog/categories')]);
  const gslugs = (await gc.json()).map((c: {slug:string}) => c.slug);
  const jslugs = (await jc.json()).map((c: {slug:string}) => c.slug);
  expect(gslugs).toContain('fresh-produce');expect(gslugs.some((s:string) => s.startsWith('jewelry-'))).toBe(false);
  expect(jslugs.every((s:string) => s.startsWith('jewelry-'))).toBe(true);
  await page.goto(grocery);await expect(page.getByRole('heading',{name:'Good food. Everyday.'})).toBeVisible();
  await page.screenshot({path:info.outputPath('grocery.png'),fullPage:true});
  // Test the current renderer with the unchanged Grocery config on the Jewelry build.
  await page.route('**/api/v1/theme/*', route => route.fulfill({json:{configuration:contract.default,cities:[]}}));
  await page.goto(jewelry);await expect(page.getByRole('heading',{name:'Good food. Everyday.'})).toBeVisible();
  await expect(page.locator('.store-shell')).toHaveAttribute('data-presentation','standard');
  await page.unroute('**/api/v1/theme/*');
  await page.route('**/api/v1/theme/*', route => route.fulfill({json:{configuration:{schema_version:'invalid'}}}));
  await page.reload();await expect(page.getByRole('heading',{name:'Good food. Everyday.'})).toBeVisible();
});

test('draft preview stays mounted when shopper session events change', async ({ page, request }) => {
  const response = await request.get(jewelry + '/api/v1/theme/storefront');
  const { configuration } = await response.json();
  const id = '11111111-1111-4111-8111-111111111111';
  let previews = 0;
  await page.route(`**/api/v1/admin/themes/${id}/preview`, route => {
    previews += 1;
    return route.fulfill({ json: configuration });
  });
  await page.goto(`${jewelry}/?theme_preview=${id}`);
  await expect(page.getByRole('heading', { name: 'A little beauty. A lasting feeling.' })).toBeVisible();
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('commerce-theme-session'));
    await new Promise(resolve => setTimeout(resolve, 250));
  });
  await expect(page.getByRole('heading', { name: 'A little beauty. A lasting feeling.' })).toBeVisible();
  expect(previews).toBe(1);
});
