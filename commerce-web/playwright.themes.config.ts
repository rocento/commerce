import { defineConfig } from '@playwright/test';
import admin from './playwright.config';

export default defineConfig({
  ...admin,
  testDir: './e2e/themes',
  outputDir: 'test-results/themes',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/themes', open: 'never' }]],
});
