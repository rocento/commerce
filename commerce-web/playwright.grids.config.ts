import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/grids',
  outputDir: 'test-results/grids',
  workers: 2,
  timeout: 30000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5184', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm --filter @commerce/admin dev --port 5184 --host 127.0.0.1', url: 'http://127.0.0.1:5184/health', reuseExistingServer: false },
});
