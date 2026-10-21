import { chromium, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const origin = 'http://127.0.0.1:5194';
const fixture = JSON.parse(readFileSync('/tmp/rocento-interactive/fixture.json', 'utf8'));
const output = process.env.PREVIEW_EVIDENCE_DIR || '/tmp/rocento-interactive/evidence';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.addCookies([{ name: 'admin_session', value: fixture.adminCookie, url: origin }]);
  const page = await context.newPage();
  await page.goto(origin);
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await page.getByRole('textbox', { name: 'English content', exact: true }).fill(Array.from({length: 28}, (_, i) => `Native scroll row ${i + 1}: real SwiftUI content`).join('\n'));
  await page.waitForTimeout(1500);
  const started = page.waitForResponse(r => r.url().includes('/sessions/worker') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Open iOS Preview', exact: true }).click();
  const session = await (await started).json();
  const canvas = page.getByRole('application', { name: 'Interactive SwiftUI iOS preview' });
  await expect(canvas).toHaveAttribute('data-live', 'true', { timeout: 180000 });
  await expect(page.locator('.ms-native-session')).toContainText('Up to date', { timeout: 60000 });
  await canvas.scrollIntoViewIfNeeded();
  await canvas.evaluate(c => {
    const chunks = []; const recorder = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    window.__nativeRecording = { recorder, chunks }; recorder.start(1000);
  });
  const before = Number(await canvas.getAttribute('data-frames'));
  const time = Date.now(); await page.waitForTimeout(5000);
  const fps = (Number(await canvas.getAttribute('data-frames')) - before) / ((Date.now() - time) / 1000);
  if (fps < 14.5) throw new Error(`Video below acceptance threshold: ${fps} fps`);
  await canvas.screenshot({ path: `${output}/native-home.png` });
  const socket = '/tmp/rocento-interactive/state/' + readdirSync('/tmp/rocento-interactive/state').find(n => n.endsWith('.sock'));
  const ax = () => execFileSync('idb', ['--log', 'ERROR', '--companion', socket, 'ui', 'describe-all', '--json'], { encoding: 'utf8', timeout: 15000 });
  // Scroll the actual SwiftUI home content and capture the resulting native image.
  let scrollReply = page.waitForResponse(r => r.url().endsWith('/input') && r.request().postDataJSON()?.kind === 'swipe');
  await canvas.hover(); await page.mouse.wheel(0, 480);
  const scrollStatus = (await scrollReply).status();
  if (scrollStatus !== 204) {
    console.log(execFileSync('idb', ['--log', 'ERROR', '--companion', socket, 'ui', 'swipe', '200', '700', '200', '300', '--duration', '0.18'], { encoding: 'utf8', timeout: 15000 }));
  }
  expect(scrollStatus).toBe(204);
  await page.waitForTimeout(700);
  await canvas.screenshot({ path: `${output}/native-scrolled.png` });
  const dragReply = page.waitForResponse(r => r.url().endsWith('/input') && r.request().postDataJSON()?.kind === 'swipe');
  const dragBox = await canvas.boundingBox();
  await page.mouse.move(dragBox.x + dragBox.width * .5, dragBox.y + dragBox.height * .65);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width * .5, dragBox.y + dragBox.height * .35, { steps: 10 });
  await page.mouse.up(); expect((await dragReply).status()).toBe(204);
  await page.waitForTimeout(500);
  await canvas.screenshot({ path: `${output}/native-dragged.png` });
  scrollReply = page.waitForResponse(r => r.url().endsWith('/input') && r.request().postDataJSON()?.kind === 'swipe');
  await page.mouse.wheel(0, -900); expect((await scrollReply).status()).toBe(204);
  await page.waitForTimeout(700);
  // Tap the actual native search field, then use browser keyboard events.
  let box = await canvas.boundingBox();
  const inputResponse = page.waitForResponse(r => r.url().endsWith('/input') && r.request().method() === 'POST');
  await canvas.click({ position: { x: box.width * .45, y: box.height * .165 } });
  expect((await inputResponse).status()).toBe(204);
  await page.waitForTimeout(700);
  await page.keyboard.type('milk', { delay: 250 });
  await expect.poll(() => JSON.parse(ax()).find(e => e.AXUniqueId === 'header-search')?.AXValue?.toLowerCase(), { timeout: 20000 }).toBe('milk');
  await page.keyboard.press('Backspace');
  await expect.poll(() => JSON.parse(ax()).find(e => e.AXUniqueId === 'header-search')?.AXValue?.toLowerCase(), { timeout: 15000 }).toBe('mil');
  await canvas.screenshot({ path: `${output}/native-keyboard.png` });
  writeFileSync(`${output}/keyboard-ax.json`, ax());
  // Browser wheel must generate a native swipe command, never scroll the page.
  const scrollResponse = page.waitForResponse(r => r.url().endsWith('/input') && r.request().postDataJSON()?.kind === 'swipe');
  await canvas.hover(); await page.mouse.wheel(0, 220);
  expect((await scrollResponse).status()).toBe(204);
  await context.setOffline(true);
  await expect(canvas).toHaveAttribute('data-live', 'false', { timeout: 10000 });
  await context.setOffline(false);
  await expect(canvas).toHaveAttribute('data-live', 'true', { timeout: 15000 });
  await canvas.focus(); await page.keyboard.type('k');
  await expect.poll(() => JSON.parse(ax()).find(e => e.AXUniqueId === 'header-search')?.AXValue?.toLowerCase(), { timeout: 15000 }).toBe('milk');
  await page.screenshot({ path: `${output}/builder-video.png`, fullPage: true });
  const recording = await page.evaluate(async () => {
    const { recorder, chunks } = window.__nativeRecording;
    await new Promise(resolve => { recorder.onstop = resolve; recorder.stop(); });
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
  writeFileSync(`${output}/native-interaction.webm`, Buffer.from(recording));
  const url = `${origin}/api/v1/merchants/${fixture.merchantId}/app-preview/sessions/${session.id}`;
  const stream = await fetch(`${url}/video`, { headers: { cookie: `admin_session=${fixture.adminCookie}` }, signal: AbortSignal.timeout(15000) });
  expect(stream.status).toBe(200);
  const reader = stream.body.getReader(); await reader.read();
  const revoked = await context.request.delete(url, { headers: { 'X-Commerce-Request': '1' } });
  expect(revoked.status()).toBe(200);
  const revokedAt = Date.now();
  while (!(await reader.read()).done) { if (Date.now() - revokedAt > 7000) throw new Error('Revoked video remained open'); }
  await expect(canvas).toHaveCount(0, { timeout: 10000 });
  writeFileSync(`${output}/result.json`, JSON.stringify({ cloud: false, transport: 'Continuous native idb Motion JPEG', fps, touch: true, keyboard: true, wheelCommand: true, drag: true, reconnect: true, serverRevocation: true }, null, 2));
  console.log(JSON.stringify({ fps, touch: true, keyboard: true, wheelCommand: true, drag: true, reconnect: true, serverRevocation: true }));
  await expect(canvas).toHaveCount(0);
} finally {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    const stop = page.getByRole('button', { name: 'Stop native preview', exact: true });
    if (await stop.count()) await stop.click().catch(() => {});
  }
  await browser.close();
}
