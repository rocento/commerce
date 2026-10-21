import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({ ...base, outputDir: 'test-results/status', use: { ...base.use, baseURL: 'http://127.0.0.1:5175' }, reporter: [['list'], ['html', { outputFolder: 'playwright-report/status', open: 'never' }]] });
