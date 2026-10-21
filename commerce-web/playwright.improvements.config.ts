import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/improvements',
  outputDir: 'test-results/improvements',
  timeout: 30000,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/improvements', open: 'never' }]],
  use: { baseURL: process.env.STATUS_ADMIN_URL || 'http://127.0.0.1:5176', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
