import { defineConfig } from '@playwright/test';
const port = Number(process.env.STOREFRONT_SMOKE_PORT || 5293);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e/quality',
  testMatch: 'storefront.spec.ts',
  outputDir: 'test-results/storefront-smoke',
  reporter: 'list',
  workers: 2,
  retries: 0,
  timeout: 30000,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', serviceWorkers: 'block' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', baseURL, viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { browserName: 'chromium', baseURL, viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js apps/storefront --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
