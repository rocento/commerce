// Run against a populated storefront or the publication performance fixture.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base = process.env.STOREFRONT_BASE_URL || 'http://127.0.0.1:4179';
const browser = await chromium.launch();
let checked = 0;
try {
  const page = await browser.newPage();
  for (const width of [320, 360, 390, 430, 768, 800, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/', '/categories/fruit', '/products/apples']) {
      await page.goto(base + path);
      await page.locator('#store-top').waitFor();
      await page.evaluate(() => document.fonts.ready);
      const tiles = await page.locator('.product-card img').evaluateAll(images => images.map(image => { const r = image.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
      for (const tile of tiles) assert.ok(Math.abs(tile.width - tile.height) <= 1, `Product image is distorted at ${width}px: ${JSON.stringify(tile)}`);
      for (const direction of ['ltr', 'rtl']) {
        const dimensions = await page.evaluate(dir => {
          document.documentElement.dir = dir;
          document.querySelector('#store-top').dir = dir;
          return { viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth };
        }, direction);
        assert.ok(dimensions.document <= width + 1 && dimensions.body <= width + 1,
          `${path} at ${width}px (${direction}) overflows: ${JSON.stringify(dimensions)}`);
        checked++;
      }
    }
  }
  console.log(`Passed ${checked} viewport/page/direction overflow checks.`);
} finally { await browser.close(); }
