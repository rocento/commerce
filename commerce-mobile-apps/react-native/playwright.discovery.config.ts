import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'discovery.spec.ts',
  use: { baseURL: 'http://127.0.0.1:8098', viewport: { width: 390, height: 844 }, trace: 'retain-on-failure' },
  webServer: { command: 'python3 -m http.server 8098 --bind 127.0.0.1 --directory dist-visual', url: 'http://127.0.0.1:8098', reuseExistingServer: !process.env.CI },
});
