import { expect, test, type Page } from '@playwright/test';

const categories = [
  { id: 'clothing', name: 'Clothing', slug: 'clothing', parent_id: null },
  { id: 'women', name: 'Women', slug: 'women', parent_id: 'clothing' },
  { id: 'dresses', name: 'Dresses', slug: 'dresses', parent_id: 'women' },
  { id: 'shoes', name: 'Shoes', slug: 'shoes', parent_id: null },
];
const product = { id: 'product-one', sku: 'DRESS-1', name: 'Summer dress', slug: 'summer-dress', description: '', price: '25.00', currency: 'USD', unit: 'each', category_id: 'dresses', category_ids: ['dresses', 'shoes'], attribute_set_id: null, attributes: {}, media_ids: [], active: true, in_stock: true, product_type: 'simple' };

async function setup(page: Page) {
  let saved: typeof product | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/admin/me', route => route.fulfill({ json: { user: { id: 'admin', name: 'Admin', email: 'admin@example.test' }, permissions: ['catalog.read', 'catalog.write', 'discovery.read'] } }));
  await page.route('**/api/v1/admin/catalog/categories', route => route.fulfill({ json: categories }));
  await page.route('**/api/v1/admin/grids/*?*', route => route.fulfill({ json: { items: [], total_count: 0, next_cursor: null } }));
  await page.route('**/api/v1/admin/catalog/products', route => {
    if (route.request().method() === 'POST') saved = { ...product, ...route.request().postDataJSON() };
    return route.fulfill({ json: saved || [] });
  });
  await page.route('**/api/v1/admin/catalog/products/product-one', route => {
    if (route.request().method() === 'PUT') saved = { ...product, ...route.request().postDataJSON() };
    return route.fulfill({ json: saved || product });
  });
  await page.route('**/api/v1/admin/catalog/products/product-one/family', route => route.fulfill({ json: { structure: { product_type: 'simple', configurable_attributes: [], children: [] }, children: [] } }));
  return { saved: () => saved, errors };
}
const section = (page: Page, name: string) => page.getByRole('complementary', { name: 'Product sections' }).getByRole('button', { name, exact: true });

test('new product saves multiple categories and SEO slug from their sections', async ({ page }) => {
  const fixture = await setup(page);
  await page.goto('/catalog/products/new');
  await page.getByLabel('Product name', { exact: true }).fill('New dress');
  await page.getByLabel('SKU', { exact: true }).fill('NEW-1');
  await expect(page.getByRole('combobox', { name: 'Primary category', exact: true })).toBeHidden();
  await expect(page.getByLabel('URL slug', { exact: true })).toBeHidden();
  await section(page, 'Category').click();
  await page.getByRole('button', { name: /Choose categories/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Select categories', exact: true });
  await expect(dialog.getByRole('tree')).toHaveAttribute('aria-multiselectable', 'true');
  await dialog.getByRole('searchbox').fill('dresses');
  await dialog.getByRole('treeitem', { name: 'Dresses', exact: true }).click();
  await dialog.getByRole('searchbox').fill('shoes');
  await dialog.getByRole('treeitem', { name: 'Shoes', exact: true }).click();
  await dialog.getByRole('button', { name: 'Apply categories' }).click();
  await page.getByRole('combobox', { name: 'Primary category', exact: true }).selectOption('shoes');
  await section(page, 'SEO').click();
  await page.getByLabel('URL slug', { exact: true }).fill('new-dress');
  await expect(page.getByText('Product URL:')).toContainText('/products/new-dress');
  await page.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/products$/);
  expect(fixture.saved()).toMatchObject({ name: 'New dress', slug: 'new-dress', category_id: 'shoes', category_ids: ['dresses', 'shoes'] });
  expect(fixture.errors).toEqual([]);
});

test('edit preserves canceled choices and reassigns a removed primary using keyboard selection', async ({ page }, info) => {
  const fixture = await setup(page);
  await page.goto('/catalog/products/product-one');
  await section(page, 'Category').click();
  const trigger = page.getByRole('button', { name: /2 categories selected/ });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Select categories', exact: true });
  const dresses = dialog.getByRole('treeitem', { name: 'Dresses', exact: true });
  await expect(dresses).toHaveAttribute('aria-checked', 'true');
  await dresses.focus();
  await page.keyboard.press('Space');
  await expect(dresses).toHaveAttribute('aria-checked', 'false');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('combobox', { name: 'Primary category', exact: true })).toHaveValue('dresses');
  await trigger.click();
  await expect(dresses).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: 'Collapse all' }).click();
  const clothing = dialog.getByRole('treeitem', { name: 'Clothing', exact: true });
  await clothing.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('treeitem', { name: 'Women', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await dialog.getByRole('button', { name: 'Expand all' }).click();
  await dresses.click();
  await page.screenshot({ path: info.outputPath('category-tree-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('category-tree-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Apply categories' }).click();
  await expect(page.getByRole('combobox', { name: 'Primary category', exact: true })).toHaveValue('shoes');
  await section(page, 'SEO').click();
  await page.getByLabel('URL slug', { exact: true }).fill('updated-dress');
  await page.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/products$/);
  expect(fixture.saved()).toMatchObject({ slug: 'updated-dress', category_id: 'shoes', category_ids: ['shoes', 'women'] });
  await page.goto('/catalog/products/product-one');
  await section(page, 'Category').click();
  await expect(page.getByRole('combobox', { name: 'Primary category', exact: true })).toHaveValue('shoes');
  await page.getByRole('button', { name: /2 categories selected/ }).click();
  await expect(dialog.getByRole('treeitem', { name: 'Women', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(fixture.errors).toEqual([]);
});

test('required category and slug validation opens the correct hidden section', async ({ page }) => {
  await setup(page);
  await page.goto('/catalog/products/new');
  await page.getByLabel('Product name', { exact: true }).fill('New dress');
  await page.getByLabel('SKU', { exact: true }).fill('NEW-1');
  await page.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Primary category', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Choose categories/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Select categories', exact: true });
  await dialog.getByRole('treeitem', { name: 'Shoes', exact: true }).click();
  await dialog.getByRole('button', { name: 'Apply categories' }).click();
  await section(page, 'Information').click();
  await page.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(page.getByLabel('URL slug', { exact: true })).toBeVisible();
  await expect(page.getByLabel('URL slug', { exact: true })).toBeFocused();
});
