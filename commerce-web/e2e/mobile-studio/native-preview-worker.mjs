// Real local worker acceptance; simulator output is never mocked.
import { chromium, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const origin = process.env.PREVIEW_BUILDER_ORIGIN || 'http://127.0.0.1:5194';
const fixture = JSON.parse(readFileSync(process.env.PREVIEW_FIXTURE_STATE || '/tmp/rocento-native-preview-state.json', 'utf8'));
const output = process.env.PREVIEW_EVIDENCE_DIR || '/tmp/rocento-worker-acceptance/evidence';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.addCookies([{ name: 'admin_session', value: fixture.adminCookie, url: origin }]);
  const page = await context.newPage();
  await page.goto(origin);
  const native = page.locator('.ms-native-session');
  await page.getByRole('button', { name: 'Open iOS Preview', exact: true }).click();
  await expect(native).toContainText('Up to date', { timeout: 180000 });
  const screen = native.getByRole('application', { name: 'Interactive SwiftUI iOS preview' });
  await expect(screen).toBeVisible({ timeout: 60000 });
  async function frame(name) {
    await expect(screen).toHaveAttribute('data-live', 'true');
    const data = await screen.evaluate(canvas => canvas.toDataURL('image/png').split(',')[1]);
    const bytes = Buffer.from(data, 'base64');
    writeFileSync(`${output}/${name}.png`, bytes);
    return createHash('sha256').update(bytes).digest('hex');
  }
  const revision = () => native.locator('[role="status"]').first().innerText();
  const before = await revision();
  const firstFrame = await frame('native-before');
  const primary = page.getByLabel('Brand color (primary hex)', { exact: true });
  await primary.fill((await primary.inputValue()) === '#7C174D' ? '#174D7C' : '#7C174D');
  const compact = page.getByRole('radio', { name: /Compact/ });
  await page.getByRole('radio', { name: (await compact.isChecked()) ? /Comfortable/ : /Compact/ }).check();
  await expect.poll(revision, { timeout: 30000 }).not.toBe(before);
  await expect(native).toContainText('Up to date', { timeout: 30000 });
  const themed = await revision();
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  const content = page.getByRole('textbox', { name: 'English content', exact: true });
  await content.fill((await content.inputValue()) === 'Real SwiftUI streamed inside Apps Builder' ? 'Native SwiftUI stream updated from the builder' : 'Real SwiftUI streamed inside Apps Builder');
  await expect.poll(revision, { timeout: 30000 }).not.toBe(themed);
  await expect(native).toContainText('Up to date', { timeout: 30000 });
  await page.waitForTimeout(6000);
  const lastFrame = await frame('native-after');
  expect(lastFrame).not.toBe(firstFrame);
  await screen.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/builder-stream.png`, fullPage: true });
  const applied = await revision();
  await context.setOffline(true);
  await expect(native).toContainText('Video disconnected', { timeout: 15000 });
  await expect(screen).toHaveAttribute('data-live', 'false');
  await context.setOffline(false);
  await expect(screen).toHaveAttribute('data-live', 'true', { timeout: 15000 });
  await page.getByRole('button', { name: 'Stop native preview', exact: true }).click();
  await expect(screen).toHaveCount(0);
  const result = { renderer: 'Signed RocentoStudio SwiftUI on a worker-owned local simulator', cloud: false, streaming: 'Continuous native video through authenticated Builder API', before, themed, applied, firstFrame, lastFrame, reconnect: true, stop: true };
  writeFileSync(`${output}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
