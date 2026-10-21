import { request, expect, type FullConfig } from '@playwright/test';

export default async function setup(config: FullConfig) {
  const email = process.env.ADMIN_TEST_EMAIL;
  const password = process.env.ADMIN_TEST_PASSWORD;
  if (!email || !password) throw new Error('Set ADMIN_TEST_EMAIL and ADMIN_TEST_PASSWORD for a local test administrator.');
  const api = await request.newContext({ baseURL: config.projects[0].use.baseURL });
  try {
    const login = await api.post('/api/v1/admin/auth/login', {
      headers: { 'X-Commerce-Request': '1' }, data: { email, password },
    });
    expect(login.status(), 'Local test administrator login; a 429 means the login rate limit must expire').toBe(200);
    await api.storageState({ path: 'test-results/.auth/admin.json' });
  } finally {
    await api.dispose();
  }
}
