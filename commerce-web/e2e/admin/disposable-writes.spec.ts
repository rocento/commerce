import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';

// Explicit opt-in: only records created by this run may be changed or removed.
test.beforeEach(() => {
  test.skip(process.env.ADMIN_TEST_DISPOSABLE_WRITES !== '1', 'Enable disposable admin acceptance writes explicitly');
});
const headers = { 'X-Commerce-Request': '1' };

test('inactive product create, edit, validation and cleanup persist through the live API', async ({ request }) => {
  const token = randomUUID();
  const root = '/api/v1/admin/catalog/products';
  const categories = await request.get('/api/v1/admin/catalog/categories');
  expect(categories.status()).toBe(200);
  const category = (await categories.json())[0];
  expect(category?.id).toBeTruthy();
  const data = { sku: `QA-${token}`, slug: `qa-${token}`, name: `Disposable regression ${token}`, description: 'Temporary acceptance fixture', price: '1.00', currency: 'EGP', unit: 'each', category_id: category.id, attributes: {}, media_ids: [], active: false, in_stock: false };
  const created = await request.post(root, { headers, data });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = await created.json();
  try {
    const updated = await request.put(`${root}/${id}`, { headers, data: { ...data, name: `${data.name} edited`, price: '2.50' } });
    expect(updated.status(), await updated.text()).toBe(200);
    const detail = await request.get(`${root}/${id}`);
    expect(detail.status()).toBe(200);
    const saved = await detail.json();
    expect(saved.name).toBe(`${data.name} edited`);
    expect(Number(saved.price)).toBe(2.5);
    expect(saved.active).toBe(false);
    const invalid = await request.put(`${root}/${id}`, { headers, data: { ...data, price: '-1' } });
    expect(invalid.status()).toBe(400);
    const unchanged = await request.get(`${root}/${id}`);
    expect(Number((await unchanged.json()).price)).toBe(2.5);
  } finally {
    expect((await request.delete(`${root}/${id}`, { headers })).status(), `Clean up disposable product ${id}`).toBe(200);
    expect((await request.get(`${root}/${id}`)).status()).toBe(404);
  }
});

test('disposable segment persists edits and rejects stale writers', async ({ request }) => {
  const token = randomUUID();
  const root = '/api/v1/admin/customer-segments';
  const data = { name: `Disposable regression ${token}`, description: 'Temporary acceptance fixture', status: 'inactive', website: 'Main Website', applyTo: 'registered', match: 'all', revision: 0, rules: [{ id: 'one', type: 'customer', attribute: 'email', operator: 'is', value: `${token}@example.test` }] };
  const created = await request.post(root, { headers, data });
  expect(created.status(), await created.text()).toBe(200);
  const first = await created.json();
  const path = `${root}/${first.id}`;
  try {
    const updated = await request.put(path, { headers, data: { ...data, name: `${data.name} edited`, revision: first.revision } });
    expect(updated.status(), await updated.text()).toBe(200);
    const stale = await request.put(path, { headers, data: { ...data, revision: first.revision } });
    expect(stale.status()).toBe(409);
    const saved = await request.get(path);
    expect((await saved.json()).name).toBe(`${data.name} edited`);
  } finally {
    const saved = await request.get(path);
    expect(saved.status()).toBe(200);
    const { revision } = await saved.json();
    expect((await request.delete(`${path}?revision=${revision}`, { headers })).status(), `Clean up disposable segment ${first.id}`).toBe(204);
    expect((await request.get(path)).status()).toBe(404);
  }
});

test('empty media folder create, rename and cleanup', async ({ request }) => {
  const root = '/api/v1/admin/catalog/media/folders';
  const name = `Disposable regression ${randomUUID()}`;
  const created = await request.post(root, { headers, data: { name, parent_id: null } });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = await created.json();
  try {
    expect((await request.put(`${root}/${id}`, { headers, data: { name: `${name} edited`, parent_id: null } })).status()).toBe(200);
    const folders = await request.get(root);
    expect(folders.status()).toBe(200);
    expect((await folders.json()).find((f: { id: string }) => f.id === id)?.name).toBe(`${name} edited`);
  } finally {
    expect((await request.delete(`${root}/${id}`, { headers })).status(), `Clean up disposable folder ${id}`).toBe(200);
    const folders = await request.get(root);
    expect((await folders.json()).some((f: { id: string }) => f.id === id)).toBe(false);
  }
});
