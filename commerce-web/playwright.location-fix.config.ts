import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./e2e/checkout',testMatch:'checkout.spec.ts',workers:1,timeout:30000,use:{baseURL:'http://127.0.0.1:5198'},reporter:'list',outputDir:'test-results/location-fix',webServer:{command:'node ../output/location-checkout-fix-20261013/serve.cjs',url:'http://127.0.0.1:5198',reuseExistingServer:false}});
