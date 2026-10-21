import { test, expect } from './fixtures';

test('published interface catalog includes the each unit in both supported languages', async ({ request }) => {
  const response = await request.get('/api/v1/languages/interface');
  expect(response.status()).toBe(200);
  const { messages } = await response.json();
  const unit = messages.find((message: { key: string }) => message.key === 'product.unit_each');
  expect(unit?.en.other).toBe('each');
  expect(unit?.ar.other).toBe('قطعة');
});

for (const grid of ['catalog', 'customers', 'orders', 'support', 'delivery-areas']) {
  test(`live ${grid} grid returns a usable page`, async ({ request }) => {
    const response = await request.get(`/api/v1/admin/grids/${grid}`, { params: { limit: '10' } });
    expect(response.status()).toBe(200);
    expect(Array.isArray((await response.json()).items)).toBe(true);
  });
}

test('delivery fee rules and area/source choices survive the scoped release', async ({ request }) => {
  const rules = await request.get('/api/v1/admin/settings/delivery-fee-rules');
  expect(rules.status()).toBe(200);
  expect(Array.isArray(await rules.json())).toBe(true);
  const choices = await request.get('/api/v1/admin/settings/delivery-fee-choices');
  expect(choices.status()).toBe(200);
  const body = await choices.json();
  expect(Array.isArray(body.areas)).toBe(true);
  expect(Array.isArray(body.sources)).toBe(true);
});
