import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/navigation', workers: 1, timeout: 30000,
  outputDir: '../artifacts/admin-navigation/browser', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5186', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node node_modules/vite/bin/vite.js apps/admin --host 127.0.0.1 --port 5186 --strictPort', url: 'http://127.0.0.1:5186', reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js apps/storefront --host 127.0.0.1 --port 5185 --strictPort', url: 'http://127.0.0.1:5185', reuseExistingServer: false },
  ],
});
