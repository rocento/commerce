import { expect, test } from '@playwright/test';
import fixture from '../src/testing/commerce-flow.json';

test('live catalog, localized search, details and native sign-in guidance', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.route('https://grocery.rocento.com/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const ar = request.headers()['x-storefront-locale'] === 'ar';
    const product = { ...fixture.product, name: ar ? 'تفاح تجريبي' : fixture.product.name };
    let body: unknown;
    if (url.pathname.endsWith('/categories')) body = [...fixture.categories.map(item => ({ ...item, name: ar ? 'الفاكهة' : item.name })), { id: '90000000-0000-0000-0000-000000000001', slug: 'child', name: 'Fresh fruit', parent_id: fixture.categories[0]!.id }];
    else if (url.pathname.endsWith('/search')) body = { hits: url.searchParams.get('q') === 'missing' ? [] : [product], total: 1 };
    else if (url.pathname.endsWith(`/products/${product.id}`)) body = product;
    else if (url.pathname.endsWith('/catalog/relationships') || url.pathname.endsWith(`/products/${product.id}/reviews`)) body = [];
    else { failures.push(`Unexpected endpoint: ${url.pathname}`); await route.abort(); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Choose delivery location' })).toBeVisible();
  await expect(page.getByText('Good food. Everyday.')).toBeVisible();
  await page.screenshot({ path: 'test-results/live-home-ios-design.png', animations: 'disabled' });
  await page.getByRole('tab', { name: 'Categories', exact: true }).click();
  await page.getByRole('button', { name: fixture.categories[0]!.name, exact: true }).click();
  await expect(page.getByTestId('subcategory-slider').getByRole('button', { name: 'Fresh fruit', exact: true })).toBeVisible();
  await page.getByTestId('subcategory-slider').getByRole('button', { name: 'Fresh fruit', exact: true }).click();
  await expect(page.getByTestId('subcategory-slider')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Cart', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Add to cart: ${fixture.product.name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await expect(page.getByText('Choose a delivery address to see available sizes and stock.')).toBeVisible();
  await page.getByRole('button', { name: 'Choose delivery address', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await expect(page.getByText('Use the iOS or Android app for secure sign-in and shopping.')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tab', { name: 'Account', exact: true }).click(); await page.getByRole('button', { name: 'Language', exact: true }).click(); await page.getByRole('button', { name: 'العربية', exact: true }).click(); await page.getByRole('button', { name: 'حسابي', exact: true }).click();
  await page.getByRole('tab', { name: 'الفئات', exact: true }).click();
  await expect(page.getByRole('button', { name: 'تفاح تجريبي', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/live-arabic.png', animations: 'disabled' });
  await page.getByRole('textbox', { name: 'ابحث عن المنتجات' }).fill('missing');
  await expect(page.getByText('لا توجد منتجات. جرّب بحثاً آخر.')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole('textbox', { name: 'ابحث عن المنتجات' }).fill('');
  await expect(page.getByRole('button', { name: 'تفاح تجريبي', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/live-arabic-narrow.png', animations: 'disabled' });
  expect(failures).toEqual([]);
});

test('network failure offers an explicit retry without demo fallback', async ({ page }) => {
  await page.route('https://grocery.rocento.com/api/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Store temporarily unavailable' }) }));
  await page.goto('/');
  await expect(page.getByText('Store temporarily unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fresh apples', exact: true })).toHaveCount(0);
});

test('large catalog mounts a bounded window and preserves the last product action', async ({ page }) => {
  const products = Array.from({ length: 240 }, (_, index) => ({ ...fixture.product,
    id: `70000000-0000-0000-0000-${String(index).padStart(12, '0')}`, name: `Stress product ${index}`, media_ids: [] }));
  await page.route('https://grocery.rocento.com/api/**', async route => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname.endsWith('/categories')) body = fixture.categories;
    else if (url.pathname.endsWith('/search')) body = { hits: products, total: products.length };
    else if (url.pathname.endsWith('/catalog/relationships') || url.pathname.endsWith('/reviews')) body = [];
    else body = products.find(product => url.pathname.endsWith(`/products/${product.id}`));
    if (!body) { await route.abort(); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Search products', exact: true }).fill('stress');
  const cards = page.locator('[data-testid^="catalog-product-"]');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeLessThan(60);
  const list = page.getByTestId('catalog-list');
  for (let i = 0; i < 80 && !(await page.getByRole('button', { name: 'Stress product 239', exact: true }).isVisible()); i++) {
    await list.evaluate(element => { element.scrollTop += element.clientHeight * 0.8; });
    await page.waitForTimeout(50);
  }
  await page.getByRole('button', { name: 'Stress product 239', exact: true }).click();
  await expect(page.getByText('Choose a delivery address to see available sizes and stock.')).toBeVisible();
  expect(await cards.count()).toBeLessThan(60);
});
