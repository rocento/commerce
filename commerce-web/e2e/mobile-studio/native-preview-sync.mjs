// Local acceptance against examples/native_preview_fixture.rs and a signed Studio build.
// Session capabilities are passed only through the child environment and never logged.
import { chromium, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const simulator = process.env.PREVIEW_SIMULATOR;
if (!simulator) throw new Error('PREVIEW_SIMULATOR is required');
const fixture = JSON.parse(readFileSync(process.env.PREVIEW_FIXTURE_STATE || '/tmp/rocento-native-preview-state.json', 'utf8'));
const output = process.env.PREVIEW_EVIDENCE_DIR || '/tmp/rocento-native-preview-evidence';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.addCookies([{ name: 'admin_session', value: fixture.adminCookie, url: 'http://127.0.0.1:5194' }]);
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5194');
  await page.getByRole('button', { name: 'Connect local app manually' }).click();
  await page.getByText('Connect local SwiftUI app').click();
  const code = await page.getByLabel('Preview session code', { exact: true }).inputValue();
  // Terminate this test app without uninstalling or touching saved credentials.
  try { execFileSync('xcrun', ['simctl', 'terminate', simulator, 'com.rocento.grocery'], { stdio: 'ignore' }); } catch {}
  execFileSync('xcrun', ['simctl', 'launch', simulator, 'com.rocento.grocery', '-rocento-draft-preview'], {
    env: { ...process.env, SIMCTL_CHILD_ROCENTO_PREVIEW_CODE: code }, stdio: 'pipe',
  });
  const native = page.locator('.ms-native-session');
  await expect(native).toContainText('Up to date', { timeout: 60000 });
  const initial = await native.locator('[role="status"]').innerText();
  execFileSync('xcrun', ['simctl', 'io', simulator, 'screenshot', `${output}/native-before.png`], { stdio: 'pipe' });
  const primary = page.getByLabel('Brand color (primary hex)', { exact: true });
  await primary.fill((await primary.inputValue()) === '#7C174D' ? '#174D7C' : '#7C174D');
  await page.getByRole('radio', { name: /Compact/ }).check();
  await expect(native).not.toContainText(initial, { timeout: 20000 });
  await expect(native).toContainText('Up to date', { timeout: 30000 });
  const themed = await native.locator('[role="status"]').innerText();
  // Change a real section through the builder's normal editor + autosave.
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  console.log('Theme update acknowledged; editing section.');
  const content = page.getByRole('textbox', { name: 'English content', exact: true });
  await content.fill((await content.inputValue()) === 'SwiftUI updated live from Apps Builder' ? 'SwiftUI live section updated again' : 'SwiftUI updated live from Apps Builder');
  await expect(native).not.toContainText(themed, { timeout: 20000 });
  await expect(native).toContainText('Up to date', { timeout: 30000 });
  execFileSync('xcrun', ['simctl', 'io', simulator, 'screenshot', `${output}/native-after.png`], { stdio: 'pipe' });
  await page.screenshot({ path: `${output}/builder-after.png`, fullPage: true });
  const section = await native.locator('[role="status"]').innerText();
  let recovery;
  if (process.env.PREVIEW_OFFLINE_MARKER) {
    writeFileSync(process.env.PREVIEW_OFFLINE_MARKER, 'offline');
    try {
      await content.fill('SwiftUI recovered the latest draft after reconnect');
      await expect(native).not.toContainText('Up to date', { timeout: 15000 });
      // Allow the native poll to observe an unavailable transport and retain its last view.
      await page.waitForTimeout(9000);
      execFileSync('xcrun', ['simctl', 'io', simulator, 'screenshot', `${output}/native-offline.png`], { stdio: 'pipe' });
    } finally { rmSync(process.env.PREVIEW_OFFLINE_MARKER, { force: true }); }
    await expect(native).toContainText('Up to date', { timeout: 45000 });
    recovery = await native.locator('[role="status"]').innerText();
    if (recovery === section) throw new Error('Reconnect did not advance the applied revision');
    execFileSync('xcrun', ['simctl', 'io', simulator, 'screenshot', `${output}/native-recovered.png`], { stdio: 'pipe' });
  }
  const result = { simulator, initial, themed, section, recovery, final: await native.locator('[role="status"]').innerText(), renderer: 'Signed RocentoStudio SwiftUI in local iOS Simulator', cloud: false, streaming: false };
  writeFileSync(`${output}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
