import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/demos', outputDir: 'test-results/demos', timeout: 60000,
  workers: 1, reporter: [['list']],
  use: { viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
});
