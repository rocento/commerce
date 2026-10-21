import { defineConfig } from '@playwright/test';

// Frontend regressions use API fixtures. Live auth, orders and mail flows use
// their existing dedicated configurations and require isolated backend services.
const evidence = process.env.ADMIN_REGRESSION_RUN_DIR || 'test-results/admin-regression';
export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'access/*.spec.ts', 'grids/*.spec.ts', 'capacity/*.spec.ts',
    'overview/*.spec.ts', 'quality/admin.spec.ts', 'quality/catalog-enrichment.spec.ts', 'quality/geography.spec.ts',
    'rows/*.spec.ts', 'csv/*.spec.ts', 'theme-editor/*.spec.ts', 'configuration/*.spec.ts',
    'email-templates/*.spec.ts', 'ai-reports/*.spec.ts',
    'marketing-notifications/*.spec.ts', 'product-relationships/*.spec.ts',
  ],
  workers: 3,
  timeout: 30000,
  retries: 0,
  outputDir: `${evidence}/browser`,
  reporter: [['list'], ['json', { outputFile: `${evidence}/playwright.json` }]],
  use: {
    baseURL: 'http://127.0.0.1:5186',
    viewport: { width: 1440, height: 1050 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js apps/admin --host 127.0.0.1 --port 5186 --strictPort',
    url: 'http://127.0.0.1:5186',
    reuseExistingServer: false,
  },
});
