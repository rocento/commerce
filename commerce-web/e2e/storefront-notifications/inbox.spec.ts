import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { StorefrontNotification } from '../../packages/api-client/src/storefront-notifications';
const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const at = '2026-10-04T12:00:00Z';
const item = (id: string, title = 'A little something new', read_at: string | null = null): StorefrontNotification => ({ id, title, body: 'Discover thoughtful new arrivals in our store.', kind: 'announcement', cta_label: 'Explore the collection', cta_path: '/search', published_at: '2026-10-03T12:00:00Z', expires_at: '2099-01-01T00:00:00Z', read_at });
async function fixture(page: Page) {
  const state = { customer: '', error: false, sessionError: false, presentation: 'standard', mutationGone: false, mutationUnauthorized: false, wrongAudience: false, productViews: [] as string[], queuedOffer: false, publications: [item('one'), item('two', 'Your weekend inspiration')], lists: 0, reads: [] as unknown[], readAll: [] as { through: string }[] };
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (path === '/api/v1/customer/auth/refresh' && state.sessionError) return route.fulfill({ status: 503, json: { error: 'Session unavailable' } });
    if (path === '/api/v1/customer/auth/refresh') return route.fulfill(state.customer ? { json: { access_token: `${state.customer}-token`, customer: { id: state.customer, email: `${state.customer}@example.test`, verified: true } } } : { status: 401, json: { error: 'Signed out' } });
    if (path === '/api/v1/customer/auth/login') { state.customer = req.postDataJSON().identifier.split('@')[0]; return route.fulfill({ json: { access_token: `${state.customer}-token`, customer: { id: state.customer, email: `${state.customer}@example.test`, verified: true } } }); }
    if (path === '/api/v1/customer/auth/logout') { state.customer = ''; return route.fulfill({ json: { ok: true } }); }
    if (path.startsWith('/api/v1/theme/')) return route.fulfill({ json: { configuration: { ...theme, global: { ...theme.global, top: [...theme.global.top, { id: 'inbox-theme', component: 'presentation', version: 1, enabled: true, settings: { style: state.presentation } }] } }, cities: [] } });
    if (path === '/api/v1/languages') return route.fulfill({ json: { source_locale: 'en', languages: [{ locale: 'en', name: 'English', native_name: 'English', direction: 'ltr' }, { locale: 'ar', name: 'Arabic', native_name: 'العربية', direction: 'rtl' }] } });
    if (path === '/api/v1/languages/interface') return route.fulfill({ json: { revision: 1, catalog_version: 'inbox-test', messages: [], overrides: [] } });
    if (path.startsWith('/api/v1/content/')) return route.fulfill({ json: { key: 'test', title: 'Store', blocks: [] } });
    if (path === '/api/v1/search') return route.fulfill({ json: { hits: [], total: 0, offset: 0, limit: 20, facets: {} } });
    if (path === '/api/v1/cart') return route.fulfill({ json: { id: 'cart', items: [], subtotal: '0.00', total: '0.00', currency: 'USD' } });
    const items = state.customer ? [{ ...item(`personal-${state.customer}`, `Private update for ${state.customer}`), kind: 'journey' }, ...state.publications] : state.publications;
    const unread = () => items.filter(value => !value.read_at).length;
    if (path === '/api/v1/notifications') {
      state.lists++;
      if (state.queuedOffer) { state.queuedOffer = false; state.publications.unshift({ ...item('tomato-offer', 'Your tomato offer'), kind: 'journey' }); }
      if (state.error) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
      const filtered = items.filter(value => url.searchParams.get('filter') !== 'unread' || !value.read_at);
      const start = url.searchParams.has('before_id') ? filtered.findIndex(value => value.id === url.searchParams.get('before_id')) + 1 : 0;
      const pageItems = filtered.slice(start, start + 20), last = pageItems.at(-1);
      return route.fulfill({ json: { items: pageItems, unread_count: unread(), snapshot_at: at, audience: state.wrongAudience ? 'guest' : state.customer ? 'customer' : 'guest', next_cursor: start + pageItems.length < filtered.length && last ? { before: last.published_at, before_id: last.id } : null } });
    }
    if (path.startsWith('/api/v1/notifications/') && req.method() !== 'GET' && req.headers()['content-type'] !== 'application/json') return route.fulfill({ status: 400, json: { error: 'Invalid storefront notification request' } });
    if (path === '/api/v1/notifications/product-view') { state.productViews.push(req.postDataJSON().product); state.queuedOffer = true; return route.fulfill({ status: 202, json: { queued: true, delivered: 0, notification_ids: [] } }); }
    if (path === '/api/v1/notifications/read-all') {
      const body = req.postDataJSON(); state.readAll.push(body);
      if (state.mutationUnauthorized) return route.fulfill({ status: 403, json: { error: 'Session revoked' } });
      items.forEach(value => { if (value.published_at <= body.through) value.read_at = at; });
      return route.fulfill({ json: { updated: items.length, unread_count: unread() } });
    }
    if (/\/notifications\/[^/]+\/read$/.test(path)) {
      const id = path.split('/').at(-2), value = items.find(value => value.id === id); state.reads.push(req.postDataJSON());
      if (state.mutationUnauthorized) return route.fulfill({ status: 401, json: { error: 'Session revoked' } });
      if (state.mutationGone || !value) return route.fulfill({ status: 404, json: { error: 'Unavailable' } });
      value.read_at = req.postDataJSON().read ? at : null;
      return route.fulfill({ json: { id, read_at: value.read_at, unread_count: unread() } });
    }
    return route.fulfill({ json: [] });
  });
  return state;
}
const bell = (page: Page) => page.getByRole('button', { name: /^Notifications(?:,|$)/ });

test('guest bell preserves unread state, provides safe links, and does not read on open', async ({ page }, info) => {
  const state = await fixture(page); await page.goto('/');
  await expect(bell(page)).toHaveAccessibleName('Notifications, 2 unread');
  await bell(page).click();
  const panel = page.getByRole('dialog', { name: 'Notifications', exact: false });
  await expect(panel).toBeVisible(); expect(state.reads).toHaveLength(0); expect(state.readAll).toHaveLength(0);
  await expect(panel.getByRole('link', { name: /Explore the collection/ }).first()).toHaveAttribute('href', '/search');
  await panel.getByRole('button', { name: /^Mark read:/ }).first().click();
  await expect(panel.getByRole('button', { name: /^Notification marked as read\.:/ })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('guest-inbox-desktop.png') });
  await page.getByRole('button', { name: 'Close notifications' }).click();
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');
  await expect(bell(page)).toBeFocused();
  await page.reload(); await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');
  await bell(page).click();
  await expect(panel.locator('.sn-item[data-unread=false]')).toContainText('A little something new');
  await expect(panel.locator('.sn-item[data-unread=true]')).toHaveCount(1);
  await expect(panel.getByText('Your weekend inspiration', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
});

test('visiting tomatoes refreshes an asynchronously delivered offer without a reload', async ({ page }) => {
  const state = await fixture(page);
  await page.route('**/api/v1/catalog/products/tomatoes', route => route.fulfill({ json: { id: 'tomatoes', slug: 'tomatoes', name: 'Tomatoes', price: '2.00', currency: 'USD', active: true, in_stock: true, media_ids: [], attributes: {}, description: '', unit: 'kg' } }));
  await page.goto('/products/tomatoes');
  await expect.poll(() => state.productViews).toEqual(['tomatoes']);
  await expect(page.locator('.sn-offer')).toContainText('Your tomato offer');
  await expect(bell(page)).toHaveAccessibleName('Notifications, 3 unread');
  await bell(page).click();
  await expect(page.getByRole('dialog').getByText('Your tomato offer', { exact: true })).toBeVisible();
});

test('alerts once for each new delivery of a campaign and ignores read-state changes', async ({ page }) => {
  const state = await fixture(page);
  state.publications = [{ ...item('repeat-campaign', 'Your returning visitor offer', at), kind: 'journey' }];
  await page.goto('/');
  await expect(bell(page)).toHaveAccessibleName('Notifications');
  await expect(page.locator('.sn-offer')).toHaveCount(0);

  const refresh = async () => {
    const lists = state.lists;
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/notifications');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await loaded;
    await expect.poll(() => state.lists).toBe(lists + 1);
    await expect(bell(page)).toHaveAccessibleName(state.publications[0].read_at ? 'Notifications' : 'Notifications, 1 unread');
  };

  // A read-state reset alone must not replay an already seen delivery.
  state.publications[0].read_at = null;
  await refresh();
  await expect(page.locator('.sn-offer')).toHaveCount(0);

  // The server reuses the publication ID, updates delivery time, and resets read state.
  state.publications[0].published_at = '2026-10-05T12:00:00Z';
  await refresh();
  await expect(page.locator('.sn-offer')).toContainText('Your returning visitor offer');
  await page.getByRole('button', { name: 'Dismiss offer', exact: true }).click();
  await refresh();
  await expect(page.locator('.sn-offer')).toHaveCount(0);

  await bell(page).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('button', { name: /^Mark read:/ }).click();
  await expect(panel.getByRole('button', { name: /^Notification marked as read\.:/ })).toBeVisible();
  await panel.getByRole('button', { name: /^Notification marked as read\.:/ }).click();
  expect(state.reads).toEqual([{ read: true }]);
  await expect(panel.locator('.sn-item[data-unread=false]')).toHaveCount(1);
  await expect(page.locator('.sn-offer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close notifications' }).click();

  state.publications[0].read_at = at;
  await refresh();
  state.publications[0].published_at = '2026-10-06T12:00:00Z';
  state.publications[0].read_at = null;
  await refresh();
  await expect(page.locator('.sn-offer')).toContainText('Your returning visitor offer');
  await page.getByRole('button', { name: 'View offer', exact: true }).click();
  await expect(panel.locator('.sn-item')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: /^Mark read:/ })).toBeVisible();
});

test('marks two different notifications read in succession', async ({ page }) => {
  const state = await fixture(page); await page.goto('/'); await bell(page).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('button', { name: /^Mark read:/ }).first().click();
  await expect(panel.getByRole('button', { name: /^Notification marked as read\.:/ })).toHaveCount(1);
  await panel.getByRole('button', { name: /^Mark read:/ }).click();
  await expect(panel.getByRole('button', { name: /^Notification marked as read\.:/ })).toHaveCount(2);
  expect(state.reads).toEqual([{ read: true }, { read: true }]);
  await page.reload(); await bell(page).click();
  await expect(panel.getByRole('button', { name: /^Notification marked as read\.:/ })).toHaveCount(2);
});

test('mark all uses the loaded snapshot and keeps newer messages unread', async ({ page }) => {
  const state = await fixture(page); await page.goto('/'); await bell(page).click();
  await expect(page.getByText('A little something new', { exact: true })).toBeVisible();
  state.publications.push({ ...item('new', 'Just arrived'), published_at: '2026-10-04T12:01:00Z' });
  await page.getByRole('button', { name: 'Mark all as read', exact: true }).click();
  await expect.poll(() => state.readAll).toEqual([{ through: at }]);
  await expect(page.getByText('Just arrived', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close notifications' }).click();
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');
});

test('pagination, failed refresh, recovery and unsafe CTA defense', async ({ page }) => {
  const state = await fixture(page); state.publications = Array.from({ length: 23 }, (_, index) => item(`news-${index}`, `Store update ${index}`));
  state.publications[0].cta_path = '//untrusted.example'; state.publications[1].cta_path = '/%2f%2funtrusted.example';
  await page.goto('/'); await bell(page).click();
  const panel = page.getByRole('dialog'); await expect(panel.getByText('Store update 0', { exact: true })).toBeVisible();
  await expect(panel.getByRole('link')).toHaveCount(18);
  await panel.getByRole('button', { name: 'Load older notifications' }).click();
  await expect(panel.getByText('Store update 22', { exact: true })).toBeVisible();
  state.error = true; await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('We couldn’t load');
  state.error = false; await panel.getByRole('button', { name: 'Try again' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('changing customer session discards personalized content and closes the inbox', async ({ page }) => {
  const state = await fixture(page); await page.goto('/login?next=cart');
  await page.getByLabel('E-mail', { exact: true }).fill('alice@example.test'); await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Login', exact: true }).click(); await expect(page).toHaveURL(/\/cart$/);
  await bell(page).click(); await expect(page.getByText('Private update for alice', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close notifications' }).click();
  await page.locator('.header-account-menu summary').click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect.poll(() => state.customer).toBe(''); await expect(page.getByText('Private update for alice', { exact: true })).toHaveCount(0);
  await bell(page).click(); await expect(page.getByRole('dialog')).toBeVisible(); await expect(page.getByText('Private update for alice', { exact: true })).toHaveCount(0);
});

test('mobile Arabic inbox is readable, accessible, and stays inside the viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page); await page.goto('/?lang=ar');
  await page.getByRole('button', { name: /الإشعارات/ }).click();
  const panel = page.getByRole('dialog'); await expect(panel).toHaveAttribute('dir', 'rtl');
  await expect(panel.getByRole('heading', { name: /الإشعارات/ })).toBeVisible();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('guest-inbox-mobile-arabic.png') });
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
});

for (const cause of ['audience', 'read', 'read-all']) {
  test(`clears personalized content after ${cause} loses session access`, async ({ page }) => {
    const state = await fixture(page); state.customer = 'alice';
    await page.goto('/'); await bell(page).click();
    await expect(page.getByText('Private update for alice', { exact: true })).toBeVisible();
    if (cause === 'audience') { state.wrongAudience = true; await page.getByRole('dialog').getByRole('button', { name: 'Refresh', exact: true }).click(); }
    else { state.mutationUnauthorized = true; await page.getByRole('dialog').getByRole('button', { name: cause === 'read' ? /^Mark read:/ : /^Mark all as read$/ }).first().click(); }
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await expect(page.getByText('Private update for alice', { exact: true })).toHaveCount(0);
  });
}

test('polls at 45 seconds while visible and resumes when the document becomes visible', async ({ page }) => {
  const state = await fixture(page); await page.clock.install(); await page.goto('/');
  await expect(bell(page)).toHaveAccessibleName('Notifications, 2 unread');
  const first = state.lists; await page.clock.fastForward(44000); expect(state.lists).toBe(first);
  await page.clock.fastForward(1001); await expect.poll(() => state.lists).toBe(first + 1);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(90001); expect(state.lists).toBe(first + 1);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => state.lists).toBe(first + 2);
});

for (const mode of ['customer', 'session-error']) {
  test(`compiled public header hydrates its notification bell safely for ${mode}`, async ({ page }, info) => {
    const built = process.env.INBOX_PUBLIC_BUILD, ssr = process.env.INBOX_PUBLIC_SSR;
    test.skip(!built || !ssr, 'Set INBOX_PUBLIC_BUILD and INBOX_PUBLIC_SSR to production client and SSR build directories.');
    const state = await fixture(page); state.customer = mode === 'customer' ? 'alice' : ''; state.sessionError = mode === 'session-error';
    const browserErrors: string[] = []; page.on('pageerror', error => browserErrors.push(error.message));
    if (!existsSync(join(ssr!, 'node_modules'))) symlinkSync(fileURLToPath(new URL('../../apps/storefront/node_modules', import.meta.url)), join(ssr!, 'node_modules'), 'dir');
    const { render } = await import(pathToFileURL(join(ssr!, 'entry-public-server.js')).href);
    const snapshot = { schema_version: 1, theme, locale: 'en', categories: [], category_id: null, product: null, kind: 'home', images: {}, collections: {}, products: [], page: 1, has_next: false, path: '/', status: 200, site_name: 'Store', content: null, guides: [], merchant: null, discovery_attribution_enabled: false };
    const markup = render(snapshot);
    expect(markup).toMatch(/aria-label="Notifications"[^>]*disabled=""/);
    expect(markup).not.toContain('Private update for alice');
    const html = readFileSync(join(built!, 'public.html'), 'utf8').replace('<!--publication-html-->', markup).replace('<!--publication-state-->', `<script id="publication-state" type="application/json">${JSON.stringify(snapshot)}</script>`);
    await page.route('**/assets/*', async route => { const path = new URL(route.request().url()).pathname; return route.fulfill({ path: join(built!, path) }); });
    await page.route('**/published-inbox', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('/published-inbox');
    if (mode === 'session-error') {
      await expect(page.getByRole('button', { name: 'Retry notifications' })).toBeVisible();
      expect(state.lists).toBe(0); state.sessionError = false;
      await page.getByRole('button', { name: 'Retry notifications' }).click();
    }
    await expect(bell(page)).toBeEnabled(); await bell(page).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText(mode === 'customer' ? 'Private update for alice' : 'A little something new', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    expect(browserErrors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`public-inbox-${mode}.png`) });
  });
}

for (const style of ['heritage', 'showcase', 'editorial']) {
  test(`bell remains visible and opens in the ${style} header on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); const state = await fixture(page); state.presentation = style;
    await page.goto('/'); await expect(bell(page)).toBeVisible(); await bell(page).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
