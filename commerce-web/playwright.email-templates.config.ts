import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/email-templates',
  workers: 2,
  timeout: 30000,
  outputDir: 'test-results/email-templates',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5197',
    viewport: { width: 1512, height: 1100 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js apps/admin --host 127.0.0.1 --port 5197 --strictPort',
    url: 'http://127.0.0.1:5197',
    reuseExistingServer: false,
  },
});
