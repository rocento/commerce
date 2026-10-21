import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./e2e/rows',outputDir:'test-results/rows',workers:1,reporter:'list',
  use:{baseURL:'http://127.0.0.1:5196',screenshot:'only-on-failure'},
  webServer:{command:'node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5196',cwd:'./apps/admin',url:'http://127.0.0.1:5196/health',reuseExistingServer:false},
});
