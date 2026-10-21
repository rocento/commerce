import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/configuration',
  workers: 2,
  timeout: 30000,
  outputDir: 'test-results/configuration/browser',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5192',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js apps/admin --host 127.0.0.1 --port 5192 --strictPort',
    url: 'http://127.0.0.1:5192',
    reuseExistingServer: false,
  },
});
