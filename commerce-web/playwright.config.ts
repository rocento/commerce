import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/admin',
  globalSetup: './e2e/admin/global-setup.ts',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: true,
  workers: 3,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.ADMIN_BASE_URL || 'http://127.0.0.1:5174',
    storageState: 'test-results/.auth/admin.json',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
