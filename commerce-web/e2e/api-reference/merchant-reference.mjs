// Local browser security check: node e2e/api-reference/merchant-reference.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/admin/public');
const requests = [], external = [], errors = [];
let permitted = true;
const spec = {
  openapi: '3.0.3', info: { title: 'Merchant security test', version: 'test' },
  paths: { '/v1/admin/products': { post: { tags: ['Catalog'], summary: 'Create product', responses: { 200: { description: 'OK' } }, security: [{ adminSession: [] }] } } },
  components: { securitySchemes: { adminSession: { type: 'apiKey', in: 'cookie', name: 'admin_session' } } },
};
const server = createServer(async (req, res) => {
  requests.push({ path: req.url, method: req.method, cookie: req.headers.cookie });
  if (req.url === '/api/v1/admin/api-reference/openapi.json') {
    assert.equal(req.method, 'GET');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'private, no-store');
    const session = req.headers.cookie?.includes('admin_session=synthetic-documentation-test');
    res.statusCode = session ? permitted ? 200 : 403 : 401;
    res.end(JSON.stringify(res.statusCode === 200 ? spec : { error: 'Denied' }));
    return;
  }
  try {
    let path = new URL(req.url, 'http://localhost').pathname;
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(root, `.${decodeURIComponent(path)}`);
    if (!file.startsWith(`${root}/`)) throw new Error('Outside asset root');
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[extname(file)] || 'text/plain');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) {
      external.push(route.request().url()); await route.abort();
    } else await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/api-reference/?url=https://untrusted.invalid/private.json&configUrl=https://untrusted.invalid/config.json`);
  await expect(page.locator('#reference-status')).toContainText('Sign in');
  assert.equal(await page.locator('.opblock').count(), 0);
  await context.addCookies([{ name: 'admin_session', value: 'synthetic-documentation-test', url: origin }]);
  permitted = false;
  await page.reload();
  await expect(page.locator('#reference-status')).toContainText('does not have');
  assert.equal(await page.locator('.opblock').count(), 0);
  permitted = true;
  await page.reload();
  await expect(page.locator('.opblock')).toHaveCount(1);
  await page.locator('.opblock-summary-control').click();
  await page.locator('.opblock-body').waitFor();
  assert.equal(await page.locator('button.authorize, button.authorization__btn').count(), 0);
  assert.equal(await page.getByRole('button', { name: /^(try it out|execute|authorize)$/i }).count(), 0);
  await page.getByPlaceholder('Filter by tag').fill('Catalog');
  await expect(page.locator('.opblock')).toHaveCount(1);
  const persisted = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));
  assert.deepEqual(persisted, { local: 0, session: 0 });
  assert.equal(await page.evaluate(() => {
    const script = document.createElement('script'); script.textContent = 'window.__inlineProbe = true'; document.head.append(script); return window.__inlineProbe === true;
  }), false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  permitted = false;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#reference-status')).toContainText('does not have');
  await expect(page.locator('.opblock')).toHaveCount(0);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  assert(requests.every(request => request.method === 'GET'));
  assert(requests.filter(request => request.path.startsWith('/api/')).every(request => request.path === '/api/v1/admin/api-reference/openapi.json'));
  console.log('PASS: anonymous/forbidden views contain no contract; permitted view remains read-only; revoked access clears on restoration; no external configuration, execution, inline scripts, storage or mobile overflow.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
