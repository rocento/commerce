import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e/access', timeout: 30000, use: { baseURL: 'http://127.0.0.1:5174', viewport: { width: 1440, height: 1000 } }, reporter: 'list' });
