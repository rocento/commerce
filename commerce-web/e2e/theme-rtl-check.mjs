import { chromium, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
const contract = JSON.parse(await readFile(new URL('../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ headless: true });
await mkdir('test-results/theme-rtl', { recursive: true });
try {
 for (const direction of ['ltr', 'rtl']) for (const width of [390, 1440]) for (const presentation of ['standard', 'showcase', 'editorial', 'heritage']) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.stack));
  const configuration = structuredClone(contract.default);
  configuration.tokens['layout.direction'] = direction;
  configuration.global.top.push({ id:'presentation-test', component:'presentation', version:1, enabled:true, settings:{style:presentation} });
  await page.route('**/api/**', route => {
   const url = new URL(route.request().url());
   let json;
   if (url.pathname.includes('/theme/')) json = { configuration, cities: [] };
   else if (url.pathname.endsWith('/search')) json = { hits: [], total: 0, facets: [] };
   else if (url.pathname.includes('/categories')) json = [];
   else if (url.pathname.includes('/auth/')) return route.fulfill({ status:401, json:{error:'Sign in required'} });
   else if (url.pathname.includes('/cart')) json = { id:'test', items:[], currency:'USD', total:'0', subtotal:'0' };
   else if (url.pathname.includes('/pages') || url.pathname.includes('/navigation')) json = {blocks:[]};
   return json === undefined ? route.fulfill({status:404,json:{error:'Not configured'}}) : route.fulfill({ json });
  });
  await page.goto(process.env.STOREFRONT_BASE_URL || 'http://127.0.0.1:5173');
  await expect(page.locator('html')).toHaveAttribute('dir',direction);
  await expect(page.locator('.store-shell')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const search = page.locator('input[role=combobox]').first();
  if (await search.isVisible()) {
   await search.focus();
   const panel = page.locator('.search-suggestions');
   await expect(panel).toBeVisible();
   const rect = await panel.boundingBox();
   expect(rect.x).toBeGreaterThanOrEqual(-1);
   expect(rect.x + rect.width).toBeLessThanOrEqual(width+1);
   await page.keyboard.press('Escape');
  }
  await page.locator('.cart-link').filter({visible:true}).first().click();
  const drawer = page.locator('.store-cart-drawer');
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  expect(Math.abs(direction === 'rtl' ? box.x : width-box.x-box.width)).toBeLessThan(2);
  await page.getByRole('button',{name:'Close cart',exact:true}).click();
  await page.screenshot({path:`test-results/theme-rtl/${presentation}-${direction}-${width}.png`,fullPage:true});
  expect(errors).toEqual([]);
  console.log(`PASS ${presentation} ${direction} ${width}px`);
  await context.close();
 }
} finally { await browser.close(); }
