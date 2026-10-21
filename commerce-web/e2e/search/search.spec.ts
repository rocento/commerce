import { test, expect } from '@playwright/test';

test('live search supports keyboard product selection, submit and browser back', async ({ page }) => {
  await page.goto('/');
  const input = page.getByRole('combobox', { name: 'Search products' });
  await input.click();
  await expect(page.getByRole('listbox', { name: 'Suggested products' }).getByRole('option').first().locator('img')).toBeVisible();
  await input.fill('tea');
  const options = page.getByRole('listbox', { name: 'Suggested products' }).getByRole('option');
  await expect(options.first()).toBeVisible();
  await expect(options.first()).toContainText(/tea/i);
  await input.press('ArrowDown');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(page).toHaveURL(/\/products\//);
  await input.fill('rice');
  await page.getByRole('search').getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/search\?q=rice/);
  await expect(page.locator('.product-card').first()).toBeVisible();
  await input.fill('tea');
  await page.getByRole('search').getByRole('button', { name: 'Search', exact: true }).click();
  await page.goBack();
  await expect(input).toHaveValue('rice');
  await input.focus();
  await input.press('Escape');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
});

for (const width of [1440, 768, 390]) test(`suggestion rows show images and fit at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.route('**/api/v1/search?*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    // Image rendering fixture; live API search is covered separately above.
    data.hits = data.hits.slice(0, 3).map((p: Record<string, unknown>) => ({ ...p, media_ids: ['search-image-fixture'] }));
    await route.fulfill({ json: data });
  });
  await page.route('**/api/v1/catalog/media/search-image-fixture/content', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#f1e2ba"/><path d="M25 20h30v45H25z" fill="#647d45"/></svg>' }));
  await page.goto('/');
  if (width <= 800) await page.getByRole('button', { name: 'Search', exact: true }).click();
  const input = page.getByRole('combobox', { name: 'Search products' });
  await input.click();
  await expect(page.getByText('Explore products', { exact: true })).toBeVisible();
  await input.fill('tea');
  const row = page.getByRole('listbox', { name: 'Suggested products' }).getByRole('option').first();
  await expect(row).toBeVisible();
  await expect(row.locator('img')).toBeVisible();
  expect(await row.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBeTruthy();
  const box = (await page.locator('.search-suggestions').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  await page.screenshot({ path: info.outputPath(`search-${width}.png`) });
  await row.click();
  await expect(page).toHaveURL(/\/products\//);
});

test('empty and failed searches offer recovery without stale suggestions', async ({ page }) => {
  await page.goto('/');
  const input = page.getByRole('combobox', { name: 'Search products' });
  await input.fill('zzzznonexistentproduct987654');
  await expect(page.getByRole('status').filter({ hasText: 'No products found' })).toBeVisible();
  await page.route('**/api/v1/search?*', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await input.fill('broken');
  await expect(page.getByText('Search is temporarily unavailable.')).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Suggested products' }).getByRole('option')).toHaveCount(0);
  await page.unroute('**/api/v1/search?*');
  await page.getByRole('button', { name: 'Try again' }).click();
  await input.fill('tea');
  await expect(page.getByRole('listbox', { name: 'Suggested products' }).getByRole('option').first()).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByText('Explore products', { exact: true })).toBeVisible();
});
