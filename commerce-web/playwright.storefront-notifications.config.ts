import { defineConfig } from '@playwright/test';
const port = Number(process.env.STOREFRONT_NOTIFICATIONS_PORT || 5298);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './e2e/storefront-notifications', outputDir: 'test-results/storefront-notifications',
  reporter: 'list', workers: 2, retries: 0, timeout: 30000,
  use: { browserName: 'chromium', baseURL, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure', serviceWorkers: 'block' },
  webServer: { command: `node node_modules/vite/bin/vite.js apps/storefront --host 127.0.0.1 --port ${port} --strictPort`, url: baseURL, reuseExistingServer: false },
});
