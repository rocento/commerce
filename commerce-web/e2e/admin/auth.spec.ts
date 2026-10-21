import { test, expect } from './fixtures';

test('unauthenticated deep link requires sign in', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/customers/profiles');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await context.close();
});

test('login from a deep link and logout prevent access after refresh', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/customers/profiles');
  await page.getByLabel('Work email').fill(process.env.ADMIN_TEST_EMAIL!);
  await page.getByLabel('Password', { exact: true }).fill(process.env.ADMIN_TEST_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Customer profiles', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Customer profiles', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await context.close();
});
