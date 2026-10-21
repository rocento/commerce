import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/theme-editor',
  outputDir: 'test-results/theme-editor',
  workers: 2,
  timeout: 30000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5188', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js apps/admin --config apps/admin/vite.config.ts --port 5188 --host 127.0.0.1',
    url: 'http://127.0.0.1:5188/health',
    reuseExistingServer: false,
  },
});
