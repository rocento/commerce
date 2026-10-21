import { test, expect } from './fixtures';

test('real order opens from grid and every left submenu works after refresh', async ({ page }) => {
  await page.goto('/sales/orders');
  const view = page.getByRole('button', { name: /^Actions for order/ }).first();
  await expect(view, 'Seed at least one local order before running the regression suite').toBeVisible();
  await view.click();
  await page.getByRole('menuitem', { name: 'View order', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Order #/);
  await page.reload();
  const menu = page.getByRole('complementary', { name: 'Order sections' });
  for (const section of ['Information', 'Items Ordered', 'Shipments', 'Comments History', 'Status History']) {
    const button = menu.getByRole('button', { name: section, exact: true });
    await button.click();
    await expect(button).toHaveClass('active');
    await expect(page.locator('.order-section-content')).not.toBeEmpty();
  }
  await page.getByRole('link', { name: 'All orders' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Orders');
});
