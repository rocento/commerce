import { test, expect } from '@playwright/test';
const base = process.env.JEWELRY_BASE_URL || 'http://localhost:5273';
for (const width of [390, 1440]) test(`automatic category filters at ${width}px`, async ({ page, request }, info) => {
  const categories = await (await request.get(base + '/api/v1/catalog/categories')).json();
  const rings = categories.find((c: {name:string}) => c.name === 'Rings');
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${base}/categories/${rings.id}`);
  if (width === 390) await page.getByRole('button', { name: 'Show filters' }).click();
  await expect(page.getByRole('button', { name: 'Apply filters' })).toHaveCount(0);
  await expect(page.locator('.color-filter')).toHaveCount(0);
  await expect(page.getByLabel('Exact color')).toHaveCount(0);
  await expect(page.locator('.catalog-layout')).toHaveAttribute('data-filter-layout', 'horizontal');
  if (width === 1440) {
    const layout = await page.locator('.catalog-layout').boundingBox();
    const products = await page.getByRole('region', { name: 'Products', exact: true }).boundingBox();
    expect(products!.x).toBeCloseTo(layout!.x, 0);
    expect(products!.width).toBeCloseTo(layout!.width, 0);
  }
  await page.getByRole('slider', { name: 'Maximum price slider' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/max=999/);
  await expect(page.getByRole('slider', { name: 'Maximum price slider' })).toBeFocused();
  await page.getByRole('spinbutton', { name: 'Maximum price', exact: true }).fill('300');
  await expect(page).toHaveURL(/max=300/);
  await expect(page.getByRole('region', { name: 'Products', exact: true })).toHaveAttribute('aria-busy', 'false');
  const response = await request.get(base + '/api/v1/search?category_id=' + rings.id + '&max_price=300');
  const result = await response.json();
  expect(result.hits.every((p: {price:string;attributes:{color:string}}) => Number(p.price) <= 300)).toBe(true);
  await page.goBack();
  await expect(page.getByRole('spinbutton', { name: 'Maximum price', exact: true })).toHaveValue('999');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`filters-${width}.png`), fullPage: false });
  await page.getByRole('button', { name: 'Reset all filters' }).click();
  await expect(page).not.toHaveURL(/attributes=|max=|min=/);
  await expect(page.getByRole('spinbutton', { name: 'Maximum price', exact: true })).toHaveValue('');
});

test('vertical filter layout retains the sidebar', async ({ page, request }) => {
  const data = await (await request.get(base + '/api/v1/theme/storefront')).json();
  data.configuration.global.top.find((s: {component:string}) => s.component === 'catalog_filters').settings.layout = 'vertical';
  await page.route('**/api/v1/theme/*', route => route.fulfill({json:data}));
  await page.goto(base + '/search');
  await expect(page.locator('.catalog-layout')).toHaveAttribute('data-filter-layout','vertical');
  const filters = await page.locator('.catalog-filter-sidebar').boundingBox();
  const products = await page.getByRole('region',{name:'Products',exact:true}).boundingBox();
  expect(products!.x).toBeGreaterThan(filters!.x + filters!.width);
  await expect(page.locator('.color-filter')).toHaveCount(0);
});
