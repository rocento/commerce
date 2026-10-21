import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir:'./e2e/quality',testMatch:'catalog-enrichment.spec.ts',workers:1,timeout:30000,
 outputDir:'test-results/enrichment',reporter:'list',
 use:{baseURL:'http://127.0.0.1:5187',screenshot:'only-on-failure',trace:'retain-on-failure'},
 webServer:{command:'node node_modules/vite/bin/vite.js apps/admin --host 127.0.0.1 --port 5187 --strictPort',url:'http://127.0.0.1:5187',reuseExistingServer:false},
});
