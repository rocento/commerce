import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: ['checkout.spec.ts', 'community.spec.ts', 'support.spec.ts', 'memory.spec.ts'],
  use: { baseURL: 'http://127.0.0.1:8102', viewport: { width: 390, height: 844 }, trace: 'retain-on-failure' },
  webServer: { command: 'python3 -m http.server 8102 --bind 127.0.0.1 --directory dist-checkout', url: 'http://127.0.0.1:8102', reuseExistingServer: false },
});
