import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/search', outputDir: 'test-results/search', timeout: 30000, workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/search', open: 'never' }]],
  use: { baseURL: process.env.STOREFRONT_TEST_URL || 'http://127.0.0.1:5177', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
