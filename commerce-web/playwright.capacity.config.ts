import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: ['capacity/*.spec.ts','checkout/checkout.spec.ts'], projects:[{name:'admin',testMatch:'capacity/*.spec.ts',use:{baseURL:'http://127.0.0.1:5199'}},{name:'storefront',testMatch:'checkout/checkout.spec.ts',use:{baseURL:'http://127.0.0.1:5198'}}], fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:5199', viewport: { width: 1440, height: 1050 } },
  reporter: 'list', outputDir: 'test-results/capacity',
  webServer: [{ command: 'cd apps/admin && ../../node_modules/.bin/vite --host 127.0.0.1 --port 5199', url: 'http://127.0.0.1:5199', reuseExistingServer: false },{ command:'cd apps/storefront && ../../node_modules/.bin/vite --host 127.0.0.1 --port 5198',url:'http://127.0.0.1:5198',reuseExistingServer:false }],
});
