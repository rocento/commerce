import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/assistant',
  outputDir: 'test-results/assistant',
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5198', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    // Use a built snapshot so concurrent workspace edits cannot reload an active journey.
    command: 'node ../../node_modules/vite/bin/vite.js build && node ../../node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5198',
    cwd: './apps/storefront',
    url: 'http://127.0.0.1:5198/health',
    reuseExistingServer: false,
  },
});
