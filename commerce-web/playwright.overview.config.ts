import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/overview',
  outputDir: 'test-results/overview',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5198', viewport: { width: 1440, height: 1050 }, screenshot: 'only-on-failure' },
  webServer: { command: 'node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198', cwd: './apps/admin', url: 'http://127.0.0.1:5198/health', reuseExistingServer: !process.env.CI },
});
