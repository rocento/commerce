import { test, expect, type BrowserContext } from '@playwright/test';

async function login(context: BrowserContext) {
  const response = await context.request.post('/api/v1/admin/auth/login', {
    headers: { 'X-Commerce-Request': '1' },
    data: { email: process.env.ADMIN_TEST_EMAIL, password: process.env.ADMIN_TEST_PASSWORD },
  });
  expect(response.status()).toBe(200);
}
test('segments persist across independent sessions, show live counts and reject stale edits', async ({ page, context, browser }) => {
  await login(context);
  const name = `Regression audience ${Date.now()}`;
  await page.goto('/customers/segments');
  await page.getByRole('button', { name: 'Add Segment', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save Segment' })).toBeDisabled();
  await page.getByLabel('Segment name').fill(name);
  await page.getByRole('button', { name: 'Conditions', exact: true }).click();
  await page.getByLabel('Value', { exact: true }).fill('gold');
  await page.getByRole('button', { name: 'Save Segment' }).click();
  await expect(page).not.toHaveURL(/\/new$/);
  const id = page.url().split('/').pop()!;
  const second = await browser.newContext({ baseURL: process.env.STATUS_ADMIN_URL || 'http://127.0.0.1:5176' });
  try {
    await login(second);
    const other = await second.newPage();
    await other.goto(`/customers/segments/${id}`);
    await expect(other.getByLabel('Segment name')).toHaveValue(name);
    await other.getByRole('button', { name: 'Matched Customers', exact: true }).click();
    await expect(other.getByText('1 customers match the saved revision 1.', { exact: true })).toBeVisible();
    await page.getByLabel('Segment name').fill(`${name} updated`);
    await page.getByRole('button', { name: 'Save Segment' }).click();
    await expect(page.getByRole('heading', {level:1})).toHaveText(`${name} updated`);
    // Keep the second browser's loaded revision; concurrent changes must not be overwritten.
    await other.getByRole('button', {name:'Properties',exact:true}).click();
    await other.getByLabel('Segment name').fill('Stale edit');
    await other.getByRole('button', {name:'Save Segment'}).click();
    await expect(other.getByRole('alert')).toContainText('Record already exists or is still in use');
    await other.reload();
    await expect(other.getByLabel('Segment name')).toHaveValue(`${name} updated`);
    await other.getByRole('button', {name:'Delete Segment'}).click();
    await other.getByRole('button', {name:'Confirm delete'}).click();
    await expect(other).toHaveURL(/\/customers\/segments$/);
  } finally {
    const saved = await context.request.get(`/api/v1/admin/customer-segments/${id}`);
    if (saved.ok()) {
      const data = await saved.json();
      await context.request.delete(`/api/v1/admin/customer-segments/${id}?revision=${data.revision}`, {headers:{'X-Commerce-Request':'1'}});
    }
    await second.close();
  }
});

test('registration and password reset arrive in the local inbox and tokens work once', async ({ request }) => {
  const email = `browser-${Date.now()}@example.test`;
  const headers = { 'X-Commerce-Request':'1' };
  const inbox = process.env.MAILPIT_TEST_URL;
  if (!inbox) throw new Error('Set MAILPIT_TEST_URL to the isolated inbox');
  const password = 'Synthetic password for test!';
  const register = await request.post('/api/v1/customer/auth/register', { headers, data:{ identifier:email,password } });
  expect(register.status()).toBe(201);
  async function message(subject:string) {
    let id = '';
    await expect.poll(async () => {
      const response = await request.get(`${inbox}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
      const result = await response.json();
      id = result.messages?.find((m:{ID:string;Subject:string}) => m.Subject===subject)?.ID ?? '';
      return !!id;
    }).toBe(true);
    return (await request.get(`${inbox}/api/v1/message/${id}`)).json();
  }
  const verification = await message('Verify your Commerce account');
  const verifyLink = verification.Text.match(/http:\/\/[^\s]+/)[0];
  const token = new URL(verifyLink).searchParams.get('token');
  const verified = await request.post('/api/v1/customer/auth/verify', {headers,data:{identifier:email,token}});
  expect(verified.ok()).toBe(true);
  const reset = await request.post('/api/v1/customer/auth/forgot-password', {headers,data:{identifier:email}});
  expect(reset.ok()).toBe(true);
  const resetMail = await message('Reset your Commerce password');
  const resetToken = new URL(resetMail.Text.match(/http:\/\/[^\s]+/)[0]).searchParams.get('token');
  const data = {identifier:email,token:resetToken,password:'A replacement test password!'};
  expect((await request.post('/api/v1/customer/auth/reset-password',{headers,data})).ok()).toBe(true);
  expect((await request.post('/api/v1/customer/auth/reset-password',{headers,data})).ok()).toBe(false);
});

test('segment conditions remain usable in a narrow viewport', async ({ page, context }, info) => {
  await login(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/customers/segments/new');
  await page.getByRole('button', {name:'Conditions',exact:true}).click();
  await expect(page.getByLabel('Value', {exact:true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('segment-mobile.png'),fullPage:true});
});
