import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e/checkout', outputDir: 'test-results/checkout', timeout: 30000, workers: 1, reporter: 'list', use: { baseURL: 'http://127.0.0.1:5188', viewport: { width: 1440, height: 1100 }, screenshot: 'only-on-failure' } });
