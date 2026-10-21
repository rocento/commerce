import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./e2e/translations',testMatch:'interface-reflection.spec.ts',workers:1,timeout:45000,reporter:'list',
  use:{baseURL:'http://127.0.0.1:5193',screenshot:'only-on-failure'},
  webServer:{command:'node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5193',cwd:'./apps/storefront',url:'http://127.0.0.1:5193/health',reuseExistingServer:true},
});
