import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'storefront.spec.ts',
  use: { baseURL: 'http://127.0.0.1:8094', viewport: { width: 390, height: 844 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'python3 -m http.server 8094 --bind 127.0.0.1 --directory dist-web',
    url: 'http://127.0.0.1:8094', reuseExistingServer: !process.env.CI,
  },
});
