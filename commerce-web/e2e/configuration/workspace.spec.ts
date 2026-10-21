import { test, expect, type Page } from '@playwright/test';
import type { DiscoverySettings, EffectiveIndexingPolicy } from '../../packages/api-client/src/discoverability';

const base = '/system/configuration';
const actorId = '10000000-0000-0000-0000-000000000001';
const feeEndpoint = '/api/v1/admin/settings/delivery-fee';

async function setup(page: Page, permissions = ['*']) {
  let amount = '5.00';
  const writes: { path: string; method: string; body: unknown }[] = [];
  const requests: string[] = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(path);
    if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(request.method())) {
      writes.push({ path, method: request.method(), body: request.postDataJSON() });
    }
    let body: unknown = [];
    if (path.endsWith('/admin/me')) {
      body = { user: { id: actorId, name: 'Configuration administrator', email: 'admin@example.test' }, permissions };
    } else if (path === `${feeEndpoint}-choices`) {
      body = { areas: [], sources: [] };
    } else if (path === feeEndpoint) {
      if (request.method() === 'PUT') amount = request.postDataJSON().amount;
      body = { amount, currency: 'USD' };
    } else if (path.endsWith('/fulfillment/capabilities')) {
      body = { system: {}, stores: [], locations: [], sources: [] };
    } else if (path.endsWith('/admin/markets')) {
      body = { items: [], live: { region: 'EG', currency: 'EGP' }, locales: ['en'], activation_available: false };
    } else if (path.endsWith('/admin/languages')) {
      body = { source_locale: 'en', languages: [], publication_available: false };
    } else if (path.endsWith('/admin/themes/assignments')) {
      body = [{ channel: 'storefront', theme_id: null, revision: 1, rules: [] }];
    } else if (path.includes('/admin/themes/target-options/')) {
      body = { segments: [], areas: [] };
    } else if (path.endsWith('/sorts')) {
      body = ['id', 'name'];
    } else if (path.includes('/grids/')) {
      body = { items: [], total_count: 0, next_cursor: null };
    }
    await route.fulfill({ json: body });
  });
  return { writes, requests };
}

async function setupDiscovery(page: Page) {
  const settings: DiscoverySettings = {
    revision: 1, enabled: true, indexing_enabled: true, llms_txt_enabled: false,
    site_name: 'Rocento Market', organization_name: 'Rocento', canonical_url: 'https://shop.example.test',
    description: 'Fresh products for your home.', default_locale: 'en', feature_pages_enabled: false,
    industry_pages_enabled: false, docs_enabled: false, pricing_page_enabled: false, security_page_enabled: false,
    integrations_page_enabled: false, changelog_enabled: false, grocery_demo_url: null, jewelry_demo_url: null,
    updated_at: '2026-10-04T09:00:00Z',
  };
  const policy: EffectiveIndexingPolicy = {
    installation_id: actorId, settings_revision: 1, merchant_preference: true, state: 'INDEXABLE',
    environment: 'production', canonical_origin: 'https://shop.example.test', response_header: 'index, follow',
    robots_meta: 'index, follow', robots_txt: 'User-agent: *\nAllow: /', deployment_override: false,
    external_headers: 'NOT_OBSERVED', warnings: [],
  };
  await page.route('**/api/v1/admin/discovery/**', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/config')) return route.fulfill({ json: settings });
    if (path.endsWith('/effective')) return route.fulfill({ json: policy });
    if (path.endsWith('/metadata')) return route.fulfill({ json: { revision: 1, configuration: { templates: {}, overrides: {}, social_image: null } } });
    if (path.endsWith('/crawlers')) return route.fulfill({ json: { revision: 1, openai_search: true, openai_training: false } });
    return route.fallback();
  });
}

function sections(page: Page) {
  return page.getByRole('navigation', { name: 'Configuration sections', exact: true });
}

test('configuration centralizes settings while Storefront owns the shopping experience', async ({ page }, info) => {
  await setup(page);
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Configuration', level: 1, exact: true })).toBeVisible();
  const administration = page.getByRole('navigation', { name: 'Administration navigation', exact: true });
  await expect(administration.locator(`a[href="${base}"]`)).toBeVisible();
  await expect(administration.locator('a[href^="/settings/"], a[href^="/discoverability"]')).toHaveCount(0);
  for (const path of ['/catalog/products', '/sales/orders', '/storefront/pages', '/storefront/markets', '/storefront/navigation', '/storefront/themes', '/storefront/channel-assignments', '/storefront/languages', '/system/roles', '/system/audit']) {
    await expect(administration.locator(`a[href="${path}"]`)).toHaveCount(1);
  }
  await expect(sections(page).locator(`a[href="${base}/channel-assignments"]`)).toHaveCount(0);
  await expect(sections(page).locator(`a[href="${base}/languages"]`)).toHaveCount(0);
  await expect(sections(page).locator(`a[href="${base}/markets"]`)).toHaveCount(0);
  for (const path of ['industry', 'fulfillment', 'delivery-fee', 'tax', 'ai-assistant', 'discoverability/overview', 'discoverability/seo', 'discoverability/ai', 'discoverability/profile', 'discoverability/performance']) {
    await expect(sections(page).locator(`a[href="${base}/${path}"]`)).toHaveCount(1);
  }
  await expect(administration.locator('summary').filter({ hasText: /^Content/ })).toHaveCount(0);
  await administration.locator('summary').filter({ hasText: /^Storefront/ }).click();
  await administration.getByRole('link', { name: 'Languages', exact: true }).click();
  await expect(page).toHaveURL('/storefront/languages');
  await expect(page.getByRole('heading', { name: 'Languages', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspace', exact: true })).toContainText('Storefront');
  for (const [path, title] of [['markets', 'Markets'], ['themes', 'Themes'], ['channel-assignments', 'Channel assignments'], ['pages', 'Pages & blocks'], ['navigation', 'Navigation']]) {
    await administration.getByRole('link', { name: title, exact: true }).click();
    await expect(page).toHaveURL(`/storefront/${path}`);
    await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible();
  }
  await administration.getByRole('link', { name: 'Markets', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Current storefront', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('storefront-desktop.png'), fullPage: true });
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 1024) await administration.getByRole('button', { name: 'Storefront', exact: true }).click();
    else await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const menu = width === 1024 ? page.getByRole('navigation', { name: 'Storefront', exact: true }) : administration;
    for (const label of ['Markets', 'Languages', 'Themes', 'Channel assignments', 'Pages & blocks', 'Navigation']) {
      await expect(menu.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`storefront-${width}.png`), fullPage: true });
  }
});

test('search filters configuration and supports empty results, clearing, and browser back', async ({ page }) => {
  await setup(page);
  await page.goto(base);
  const search = page.getByRole('searchbox', { name: 'Search configuration', exact: true });
  await search.fill('delivery fee');
  await expect(sections(page).locator(`a[href="${base}/delivery-fee"]`)).toBeVisible();
  await expect(sections(page).locator(`a[href="${base}/tax"]`)).toHaveCount(0);
  await search.fill('no-configuration-matches-this-query');
  await expect(page.getByText(/No (configuration )?(sections|settings|results|matches)/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(sections(page).locator(`a[href="${base}/tax"]`)).toBeVisible();
  await sections(page).locator(`a[href="${base}/delivery-fee"]`).click();
  await expect(page).toHaveURL(`${base}/delivery-fee`);
  await expect(page.getByRole('heading', { name: 'Delivery fee', level: 2, exact: true })).toBeVisible();
  await expect(sections(page).locator(`a[href="${base}/delivery-fee"]`)).toHaveAttribute('aria-current', 'page');
  await sections(page).locator(`a[href="${base}/tax"]`).click();
  await expect(page).toHaveURL(`${base}/tax`);
  await page.goBack();
  await expect(page).toHaveURL(`${base}/delivery-fee`);
  await expect(page.getByRole('heading', { name: 'Delivery fee', level: 2, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
});

test('legacy settings bookmarks preserve query parameters and hash fragments', async ({ page }) => {
  // An unprivileged identity also proves redirecting a bookmark does not grant access.
  const state = await setup(page, []);
  const aliases = [
    ['/settings/catalog/industry', 'industry'],
    ['/settings/fulfillment', 'fulfillment'],
    ['/settings/delivery-fee', 'delivery-fee'],
    ['/settings/tax', 'tax'],
    ['/settings/ai-assistant', 'ai-assistant'],
    ['/settings/discoverability', 'discoverability/overview'],
    ['/discoverability', 'discoverability/overview'],
    ...['overview', 'seo', 'ai', 'profile', 'performance'].map(path => [`/discoverability/${path}`, `discoverability/${path}`]),
  ];
  for (const [legacy, canonical] of aliases) {
    await page.goto(`${legacy}?store=default&tab=review#configuration-details`);
    await expect(page).toHaveURL(`${base}/${canonical}?store=default&tab=review#configuration-details`);
  }
  await page.goto(`${base}/channel-assignments?store=default&tab=review#configuration-details`);
  await expect(page).toHaveURL('/storefront/channel-assignments?store=default&tab=review#configuration-details');
  await expect(page.getByRole('heading', { name: 'This page isn’t available', level: 1, exact: true })).toBeVisible();
  expect(state.requests).not.toContain('/api/v1/admin/themes/assignments');
  for (const legacy of ['/settings/languages', `${base}/languages`, '/content/languages']) {
    await page.goto(`${legacy}?store=default&tab=review#configuration-details`);
    await expect(page).toHaveURL('/storefront/languages?store=default&tab=review#configuration-details');
    await expect(page.getByRole('heading', { name: 'This page isn’t available', level: 1, exact: true })).toBeVisible();
  }
  expect(state.requests).not.toContain('/api/v1/admin/languages');
  for (const [legacy, canonical] of [
    ['/settings/markets', 'markets'], [`${base}/markets`, 'markets'],
    ['/content/themes', 'themes'], ['/content/theme-assignments', 'channel-assignments'],
    ['/content/navigation', 'navigation'], ['/content/pages', 'pages'],
  ]) {
    await page.goto(`${legacy}?store=default&tab=review#configuration-details`);
    await expect(page).toHaveURL(`/storefront/${canonical}?store=default&tab=review#configuration-details`);
    await expect(page.getByRole('heading', { name: 'This page isn’t available', level: 1, exact: true })).toBeVisible();
  }
  expect(state.requests).not.toContain('/api/v1/admin/markets');
});

test('delivery settings viewers can find System Configuration without unrelated grants', async ({ page }) => {
  const state = await setup(page, ['fulfillment.settings.view']);
  await page.goto(base);
  const administration = page.getByRole('navigation', { name: 'Administration navigation', exact: true });
  await expect(administration.locator(`a[href="${base}"]`)).toBeVisible();
  await expect(sections(page).locator(`a[href="${base}/fulfillment"]`)).toBeVisible();
  for (const path of ['markets', 'delivery-fee', 'tax', 'ai-assistant', 'channel-assignments']) {
    await expect(sections(page).locator(`a[href="${base}/${path}"]`)).toHaveCount(0);
  }
  await sections(page).locator(`a[href="${base}/fulfillment"]`).click();
  await expect(page.getByRole('heading', { name: 'Delivery & pickup settings', level: 2, exact: true })).toBeVisible();
  await expect(page.getByText('Read-only access', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Add store or branch|Save fulfillment settings/ })).toHaveCount(0);
  await page.goto(`${base}/delivery-fee`);
  await expect(page.getByRole('button', { name: 'Save delivery fee', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /isn’t available|not available|access|permission/i }).first()).toBeVisible();
  expect(state.requests).not.toContain(feeEndpoint);
  expect(state.writes).toEqual([]);
});

test('read-only configuration grants filter navigation and gate direct routes', async ({ page }) => {
  const state = await setup(page, ['fulfillment.settings.read', 'tax.read']);
  await page.goto(`${base}/delivery-fee`);
  await expect(sections(page).locator(`a[href="${base}/delivery-fee"]`)).toBeVisible();
  await expect(sections(page).locator(`a[href="${base}/tax"]`)).toBeVisible();
  await expect(sections(page).locator(`a[href="${base}/markets"]`)).toHaveCount(0);
  await expect(page.getByText('Read-only access', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Public default: 5.00 USD', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save delivery fee', exact: true })).toHaveCount(0);
  await sections(page).locator(`a[href="${base}/tax"]`).click();
  await expect(page.getByRole('heading', { name: 'Tax rules', level: 2, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add tax rule', exact: true })).toHaveCount(0);
  await page.goto(`${base}/markets`);
  await expect(page.getByRole('heading', { name: /isn’t available|not available|access|permission/i }).first()).toBeVisible();
  expect(state.requests).not.toContain('/api/v1/admin/markets');
  expect(state.writes).toEqual([]);
});

test('users without configuration grants see a clear unavailable state', async ({ page }) => {
  const state = await setup(page, ['orders.read']);
  await page.goto(base);
  await expect(page.getByRole('navigation', { name: 'Administration navigation', exact: true }).locator(`a[href="${base}"]`)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /isn’t available|not available|access|permission/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Save|Add market/ })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('channel-scoped theme readers find read-only channel assignments in Storefront', async ({ page }) => {
  const state = await setup(page, ['theme.read@storefront']);
  await page.goto('/storefront/themes');
  const administration = page.getByRole('navigation', { name: 'Administration navigation', exact: true });
  await expect(administration.locator(`a[href="${base}"]`)).toHaveCount(0);
  await expect(administration.locator('a[href="/storefront/channel-assignments"]')).toBeVisible();
  await administration.locator('a[href="/storefront/channel-assignments"]').click();
  await expect(page).toHaveURL('/storefront/channel-assignments');
  await expect(page.getByRole('heading', { name: 'Channel assignments', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspace', exact: true })).toContainText('Storefront');
  await expect(page.getByRole('combobox', { name: 'Default theme', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save assignment', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add targeting rule', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('delivery fee changes keep the existing audited save API and survive reload', async ({ page }) => {
  const state = await setup(page, ['fulfillment.settings.read', 'fulfillment.settings.write']);
  await page.goto(`${base}/delivery-fee`);
  await page.getByLabel('Public default fee (USD)', { exact: true }).fill('7.25');
  await page.getByRole('combobox', { name: 'Change reason', exact: true }).selectOption('Carrier rate change');
  await page.getByRole('button', { name: 'Save delivery fee', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Delivery fee saved.' })).toBeVisible();
  expect(state.writes).toEqual([{ path: feeEndpoint, method: 'PUT', body: { amount: '7.25', reason: 'Carrier rate change' } }]);
  await expect(page.getByRole('heading', { name: 'Public default: 7.25 USD', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Public default: 7.25 USD', exact: true })).toBeVisible();
});

test('delivery fee draft navigation can be cancelled or discarded and saving clears its guard', async ({ page }) => {
  const state = await setup(page, ['fulfillment.settings.read', 'fulfillment.settings.write', 'tax.read']);
  const dialogs: string[] = [];
  let discard = false;
  page.on('dialog', async dialog => {
    dialogs.push(dialog.message());
    expect(dialog.type()).toBe('confirm');
    if (discard) await dialog.accept();
    else await dialog.dismiss();
  });
  await page.goto(`${base}/delivery-fee`);
  const amount = page.getByLabel('Public default fee (USD)', { exact: true });
  const reason = page.getByRole('combobox', { name: 'Change reason', exact: true });
  const taxes = sections(page).locator(`a[href="${base}/tax"]`);
  await amount.fill('9.25');
  await reason.selectOption('Carrier rate change');
  await taxes.click();
  await expect(page).toHaveURL(`${base}/delivery-fee`);
  await expect(amount).toHaveValue('9.25');
  await expect(reason).toHaveValue('Carrier rate change');
  expect(dialogs).toEqual(['Discard unsaved changes and leave this page?']);
  expect(state.writes).toEqual([]);

  discard = true;
  await taxes.click();
  await expect(page).toHaveURL(`${base}/tax`);
  expect(dialogs).toHaveLength(2);
  expect(state.writes).toEqual([]);
  await sections(page).locator(`a[href="${base}/delivery-fee"]`).click();
  await expect(amount).toHaveValue('');
  await expect(reason).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Public default: 5.00 USD', exact: true })).toBeVisible();

  await amount.fill('8.50');
  await reason.selectOption('Delivery cost adjustment');
  await page.getByRole('button', { name: 'Save delivery fee', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Delivery fee saved.' })).toBeVisible();
  await expect(amount).toHaveValue('');
  await expect(reason).toHaveValue('');
  discard = false;
  await taxes.click();
  await expect(page).toHaveURL(`${base}/tax`);
  expect(dialogs).toHaveLength(2);
  expect(state.writes).toEqual([{ path: feeEndpoint, method: 'PUT', body: { amount: '8.50', reason: 'Delivery cost adjustment' } }]);
});

test('discovery sidebar navigation preserves SEO drafts across AI settings', async ({ page }, info) => {
  const state = await setup(page, ['discovery.read', 'discovery.write']);
  await setupDiscovery(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/discoverability/seo`);
  await expect(page.getByRole('heading', { name: 'Search engine optimization', level: 2, exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Search and AI sections', exact: true })).toHaveCount(0);
  const storeName = page.getByLabel('Store name', { exact: true });
  await expect(storeName).toHaveValue('Rocento Market');
  await storeName.fill('Rocento Market — Spring draft');
  await sections(page).locator(`a[href="${base}/discoverability/ai"]`).click();
  await expect(page).toHaveURL(`${base}/discoverability/ai`);
  await expect(page.getByRole('heading', { name: 'AI & crawler access', level: 2, exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'OpenAI · Search preference', exact: true })).toHaveValue('true');
  await sections(page).locator(`a[href="${base}/discoverability/seo"]`).click();
  await expect(page).toHaveURL(`${base}/discoverability/seo`);
  await expect(storeName).toHaveValue('Rocento Market — Spring draft');
  await expect(page.getByRole('heading', { name: 'Configuration', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('discovery-seo-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('discovery-seo-mobile.png'), fullPage: true });
  expect(state.writes).toEqual([]);
  expect(errors).toEqual([]);
});

for (const width of [1440, 1024, 390]) {
  test(`configuration overview and settings fit a ${width}px viewport`, async ({ page }, info) => {
    await setup(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const path of [base, `${base}/delivery-fee`, `${base}/tax`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Configuration', level: 1, exact: true })).toBeVisible();
      if (path.endsWith('/tax')) {
        await expect(page.getByRole('heading', { name: 'Tax rules', level: 2, exact: true })).toBeVisible();
        await expect(page.getByText('No tax rules configured. Checkout tax is zero.', { exact: true })).toBeVisible();
      } else if (path.endsWith('/delivery-fee')) {
        await expect(page.getByRole('heading', { name: 'Public default: 5.00 USD', exact: true })).toBeVisible();
      }
      const screenshotName = path === base ? 'overview' : path.split('/').at(-1);
      const sectionToggle = page.locator('.configuration-mobile-toggle');
      if (await sectionToggle.isVisible()) await sectionToggle.click();
      await expect(page.getByRole('searchbox', { name: 'Search configuration', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (await sectionToggle.isVisible()) {
        await page.screenshot({ path: info.outputPath(`${screenshotName}-navigation.png`), fullPage: true });
        await sectionToggle.click();
        await expect(sectionToggle).toHaveAttribute('aria-expanded', 'false');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`${screenshotName}.png`), fullPage: true });
    }
  });
}


for (const canWrite of [true, false]) test(`industry default configuration is explicit and permission gated (${canWrite})`, async ({ page }) => {
  await setup(page, canWrite ? ['attributes.read', 'attributes.write'] : ['attributes.read']);
  const profile = { id: actorId, code: 'grocery', name: 'Grocery', status: 'active', version: 1, metadata: {}, template: [] };
  let version = 0;
  const configuration = () => ({ industry_profile_id: version ? actorId : null, default_attribute_set_id: null, version });
  const writes: unknown[] = [];
  await page.route('**/api/v1/admin/catalog/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/industry-profiles')) return route.fulfill({ json: [profile] });
    if (path.endsWith('/preview')) return route.fulfill({ json: { configuration: configuration(), profile, attributes: [
      { code: 'pack_weight', label: 'Pack weight', group: 'Packaging', action: 'configure_default', reason: 'Unused platform default adopts the selected industry unit.' },
    ] } });
    if (path.endsWith('/industry')) {
      if (route.request().method() === 'PUT') { writes.push(route.request().postDataJSON()); version++; }
      return route.fulfill({ json: configuration() });
    }
    if (path.endsWith('/discovery')) return route.fulfill({ json: { products_evaluated: 0, enabled: false, bounded: false, pending_relationships: 0, categories: [], rankings: [] } });
    return route.fallback();
  });
  await page.goto(`${base}/industry`);
  await expect(page.getByRole('heading', { name: 'Catalog setup', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI discoverability coverage' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View AI coverage and discovery ranking in Catalog enrichment →' })).toHaveAttribute('href', '/catalog/enrichment');
  await page.getByRole('combobox', { name: 'Industry profile', exact: true }).selectOption(actorId);
  await expect(page.getByRole('cell', { name: 'Configure default', exact: false })).toBeVisible();
  const include = page.getByRole('checkbox', { name: 'Include Pack weight', exact: true });
  await expect(include).toBeChecked();
  expect(writes).toEqual([]);
  if (canWrite) {
    await expect(include).toBeEnabled();
    await page.getByRole('button', { name: 'Review changes', exact: true }).click();
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: 'Confirm and apply', exact: true }).click();
    await expect.poll(() => writes).toEqual([{ profile_id: actorId, profile_version: 1, expected_version: 0, selected_codes: ['pack_weight'], confirmed: true }]);
  } else {
    await expect(include).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toHaveCount(0);
  }
});
