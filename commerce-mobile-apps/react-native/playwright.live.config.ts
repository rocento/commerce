import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'live.spec.ts',
  use: { baseURL: 'http://127.0.0.1:8097', viewport: { width: 390, height: 844 }, trace: 'retain-on-failure' },
  webServer: { command: 'python3 -m http.server 8097 --bind 127.0.0.1 --directory dist-live', url: 'http://127.0.0.1:8097', reuseExistingServer: !process.env.CI },
});
