import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Theme, ThemeConfiguration } from '../../packages/api-client/src/themes';

const contract = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8'));
const categories = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Clothing', slug: 'clothing', parent_id: null },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Women', slug: 'women', parent_id: '11111111-1111-4111-8111-111111111111' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Dresses', slug: 'dresses', parent_id: '22222222-2222-4222-8222-222222222222' },
  { id: '44444444-4444-4444-8444-444444444444', name: 'Shoes', slug: 'shoes', parent_id: null },
];
const media = { id: '55555555-5555-4555-8555-555555555555', alt: 'Summer collection', content_type: 'image/png' };

async function setup(page: Page, permissions = ['*'], category = '') {
  let saved: Theme = { id: '66666666-6666-4666-8666-666666666666', name: 'Collection theme', owner_channel: 'storefront', revision: 1, published_version: null, updated_at: '2026-09-22T10:00:00Z', configuration: structuredClone(contract.default) };
  saved.configuration.pages.home.push({ id: 'collection-test', component: 'product_collection', version: 1, enabled: true, settings: { heading: 'Summer edit', limit: 8, query: '', category } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/languages', route => route.fulfill({ json: { source_locale: 'en', languages: [] } }));
  await page.route('**/api/v1/admin/me', route => route.fulfill({ json: { user: { id: saved.id, name: 'Theme editor', email: 'editor@example.test' }, permissions } }));
  await page.route('**/api/v1/admin/themes', route => route.fulfill({ json: [saved] }));
  await page.route('**/api/v1/admin/themes/assignments', route => route.fulfill({ json: [{ channel: 'storefront', theme_id: null, revision: 1, rules: [] }] }));
  await page.route(`**/api/v1/admin/themes/${saved.id}`, route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { configuration: ThemeConfiguration; expected_revision: number };
      expect(body.expected_revision).toBe(saved.revision);
      saved = { ...saved, revision: saved.revision + 1, configuration: body.configuration };
    }
    return route.fulfill({ json: saved });
  });
  await page.route('**/api/v1/admin/catalog/categories', route => route.fulfill({ json: categories }));
  await page.route('**/api/v1/admin/catalog/media', route => route.fulfill({ json: [media] }));
  await page.route('**/api/v1/catalog/media/*/content', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#e2e8d9"/><circle cx="150" cy="90" r="60" fill="#899976"/></svg>' }));
  await page.goto('/content/themes');
  await page.getByRole('button', { name: 'Actions for Collection theme', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open theme', exact: true }).click();
  await page.locator('.theme-section-title').filter({ hasText: 'Product collection' }).click();
  const section = page.locator('.theme-section-editor').filter({ has: page.locator('.theme-section-title').filter({ hasText: 'Product collection' }) });
  return { section, errors, saved: () => saved };
}

test('category tree search, explicit apply, cancel, saved IDs and reload', async ({ page }) => {
  const fixture = await setup(page);
  const picker = fixture.section.getByRole('group', { name: 'Category', exact: true });
  await picker.getByRole('button', { name: /All categories/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Select category' });
  await expect(dialog.getByRole('searchbox')).toBeFocused();
  await dialog.getByRole('searchbox').fill('dresses');
  await expect(dialog.getByRole('treeitem')).toHaveCount(3);
  await dialog.getByRole('treeitem', { name: 'Dresses', exact: true }).click();
  await expect(dialog.locator('.category-picker-chosen')).toContainText('Clothing / Women / Dresses');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(picker.getByRole('button', { name: /All categories/ })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await picker.getByRole('button', { name: /All categories/ }).click();
  await dialog.getByRole('searchbox').fill('dresses');
  await dialog.getByRole('treeitem', { name: 'Dresses', exact: true }).click();
  await dialog.getByRole('button', { name: 'Apply category' }).click();
  await expect(picker).toContainText('Clothing / Women / Dresses');
  await fixture.section.getByLabel('Search keywords', { exact: true }).fill('linen');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  expect(fixture.saved().configuration.pages.home.at(-1)?.settings).toMatchObject({ category: categories[2].id, query: 'linen', limit: 8 });
  await page.getByRole('button', { name: 'Back to themes' }).click();
  await page.getByRole('button', { name: 'Actions for Collection theme', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open theme', exact: true }).click();
  await page.locator('.theme-section-title').filter({ hasText: 'Product collection' }).click();
  await expect(picker).toContainText('Clothing / Women / Dresses');
  await picker.getByRole('button', { name: /Dresses/ }).click();
  await expect(dialog.getByRole('treeitem', { name: 'Dresses', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(picker.getByRole('button', { name: /Dresses/ })).toBeFocused();
  await picker.getByRole('button', { name: 'Clear category filter' }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => fixture.saved().configuration.pages.home.at(-1)?.settings.category).toBe('');
  expect(fixture.errors).toEqual([]);
});

test('tree supports arrow keys, parent navigation, Home, End and selection', async ({ page }) => {
  const { section, errors } = await setup(page);
  await section.getByRole('button', { name: /All categories/ }).click();
  const dialog = page.getByRole('dialog');
  const clothing = dialog.getByRole('treeitem', { name: 'Clothing', exact: true });
  await clothing.focus();
  await page.keyboard.press('ArrowRight');
  await expect(clothing).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('treeitem', { name: 'Women', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('treeitem', { name: 'Dresses', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(dialog.getByRole('treeitem', { name: 'Dresses', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByRole('treeitem', { name: 'Women', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(dialog.getByRole('treeitem', { name: 'Shoes', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(clothing).toBeFocused();
  await dialog.getByRole('button', { name: 'Apply category' }).click();
  await expect(section.getByRole('button', { name: /Dresses/ })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`picker and section layout fit ${width}px`, async ({ page }, info) => {
    const { section, errors } = await setup(page);
    await page.setViewportSize({ width, height: 900 });
    await section.getByRole('button', { name: /All categories/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Expand all' }).click();
    await dialog.getByRole('treeitem', { name: 'Dresses', exact: true }).click();
    const header = await dialog.locator('header').boundingBox();
    const description = await dialog.locator('header p').boundingBox();
    expect(description!.y + description!.height).toBeLessThan(header!.y + header!.height);
    await page.screenshot({ path: info.outputPath(`category-tree-${width}.png`) });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Apply category' }).click();
    await page.screenshot({ path: info.outputPath(`section-settings-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('missing categories, loading failure, retry and empty search do not silently replace saved values', async ({ page }) => {
  const { section, saved } = await setup(page, ['*'], 'deleted-category');
  await expect(section).toContainText('This saved category no longer exists.');
  await section.getByRole('button', { name: /Unavailable category/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Apply category' })).toBeDisabled();
  await dialog.getByRole('searchbox').fill('not a category');
  await expect(dialog).toContainText('No matching categories.');
  await page.keyboard.press('Escape');
  expect(saved().configuration.pages.home.at(-1)?.settings.category).toBe('deleted-category');
  await page.route('**/api/v1/admin/catalog/categories', route => route.fulfill({ status: 503, json: { error: 'Try again' } }));
  await page.reload();
  await page.getByRole('button', { name: 'Actions for Collection theme', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open theme', exact: true }).click();
  await page.locator('.theme-section-title').filter({ hasText: 'Product collection' }).click();
  await expect(section).toContainText('Could not load categories.');
  await section.getByRole('button', { name: /Saved category/ }).click();
  await expect(dialog.getByRole('button', { name: 'Apply category' })).toBeDisabled();
  await page.route('**/api/v1/admin/catalog/categories', route => route.fulfill({ json: [] }));
  await dialog.getByRole('button', { name: 'Retry categories' }).click();
  await expect(dialog).toContainText('No categories yet.');
  await dialog.getByRole('button', { name: /All categories/ }).click();
  await dialog.getByRole('button', { name: 'Apply category' }).click();
  await expect(section.getByRole('button', { name: /All categories/ })).toBeVisible();
});

test('catalog and theme permissions govern pickers without dropping existing selections', async ({ page }) => {
  const catalogRequests: string[] = [];
  page.on('request', request => { if (/\/admin\/catalog\/(categories|media)$/.test(request.url())) catalogRequests.push(request.url()); });
  const { section } = await setup(page, ['theme.read', 'theme.edit'], categories[2].id);
  await expect(section.getByRole('button', { name: /Saved category/ })).toBeDisabled();
  await expect(section).toContainText('Catalog read permission is required');
  expect(catalogRequests).toEqual([]);
  await page.route('**/api/v1/admin/me', route => route.fulfill({ json: { user: { id: 'editor', name: 'Reader' }, permissions: ['theme.read', 'catalog.read'] } }));
  await page.reload();
  await page.getByRole('button', { name: 'Actions for Collection theme', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open theme', exact: true }).click();
  await page.locator('.theme-section-title').filter({ hasText: 'Product collection' }).click();
  await expect(section.getByRole('button', { name: /Dresses/ })).toBeDisabled();
  await expect(section.getByRole('button', { name: 'Clear category filter' })).toBeDisabled();
  await expect(section.getByRole('button', { name: 'Duplicate Product collection' })).toBeDisabled();
});

test('visual images, category links, validation, duplication and undo preserve section configuration', async ({ page }) => {
  const { section, saved, errors } = await setup(page);
  await section.getByLabel('Maximum items', { exact: true }).fill('0');
  await expect(section.getByLabel('Maximum items', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await section.getByLabel('Maximum items', { exact: true }).fill('12');
  await section.getByRole('button', { name: 'Duplicate Product collection' }).click();
  await expect(section).toHaveCount(2);
  await section.last().getByRole('button', { name: 'Remove Product collection' }).click();
  await expect(section).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo removal' }).click();
  await expect(section).toHaveCount(2);
  await page.getByLabel('New component', { exact: true }).selectOption('image_text');
  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  const story = page.locator('.theme-section-editor').filter({ has: page.locator('.theme-section-title').filter({ hasText: 'Image and text' }) });
  await story.getByRole('button', { name: 'Choose section image' }).click();
  await page.getByRole('dialog').getByRole('searchbox').fill('Summer');
  await page.getByRole('dialog').getByRole('button', { name: 'Select Summer collection' }).click();
  await expect(story.getByLabel('image description', { exact: true })).toHaveValue('Summer collection');
  await story.getByLabel('image description', { exact: true }).fill('');
  await expect(story.getByLabel('image description', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await story.getByLabel('image description', { exact: true }).fill('Summer collection');
  await story.getByText('Choose a store destination', { exact: true }).click();
  await story.getByRole('button', { name: /Choose a category/ }).click();
  await page.getByRole('dialog').getByRole('searchbox').fill('Dresses');
  await page.getByRole('treeitem', { name: 'Dresses', exact: true }).click();
  await page.getByRole('button', { name: 'Apply category' }).click();
  await expect(story.getByLabel('destination', { exact: true })).toHaveValue('/categories/dresses');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  const sections = saved().configuration.pages.home;
  expect(new Set(sections.map(item => item.id)).size).toBe(sections.length);
  expect(sections.filter(item => item.component === 'product_collection').map(item => item.settings.limit)).toEqual([12, 12]);
  expect(sections.at(-1)?.settings).toMatchObject({ image: media.id, alt: media.alt, href: '/categories/dresses' });
  expect(errors).toEqual([]);
});

test('media failures offer retry and preserve authored descriptions when choosing an image', async ({ page }) => {
  const { errors } = await setup(page);
  await page.route('**/api/v1/admin/catalog/media', route => route.fulfill({ status: 503, json: { error: 'Try again' } }));
  await page.reload();
  await page.getByRole('button', { name: 'Actions for Collection theme', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open theme', exact: true }).click();
  await page.locator('.theme-section-title').filter({ hasText: /^Hero/ }).click();
  const hero = page.locator('.theme-section-editor').filter({ has: page.locator('.theme-section-title').filter({ hasText: /^Hero/ }) });
  await hero.getByLabel('image description', { exact: true }).fill('My accessible description');
  await hero.getByRole('button', { name: 'Choose section image' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Images could not be loaded.');
  await page.route('**/api/v1/admin/catalog/media', route => route.fulfill({ json: [media] }));
  await dialog.getByRole('button', { name: 'Retry images' }).click();
  await dialog.getByRole('button', { name: 'Select Summer collection' }).click();
  await expect(hero.getByLabel('image description', { exact: true })).toHaveValue('My accessible description');
  await hero.getByRole('button', { name: 'Remove section image' }).click();
  await expect(hero.getByLabel('image description', { exact: true })).toHaveValue('My accessible description');
  expect(errors).toEqual([]);
});

test('Arabic font selection saves and preserves theme defaults', async ({ page }) => {
  const fixture = await setup(page);
  let published: ThemeConfiguration | undefined;
  await page.route('**/api/v1/admin/themes/*/publish', route => {
    published = structuredClone(fixture.saved().configuration);
    return route.fulfill({ json: { id: 'font-version', version: 1, configuration: published } });
  });
  await page.getByRole('tab', { name: 'Fonts', exact: true }).click();
  await expect(page.getByLabel('Body font', { exact: true })).toHaveValue(String(contract.default.tokens['font.body']));
  await expect(page.getByLabel('Arabic body font', { exact: true })).toHaveValue('inherit');
  await page.getByLabel('Arabic body font', { exact: true }).selectOption('Cairo');
  await page.getByLabel('Arabic heading font', { exact: true }).selectOption('Tajawal');
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  expect(fixture.saved().configuration.tokens['font.arabic.body']).toBe('Cairo');
  expect(fixture.saved().configuration.tokens['font.body']).toBe(contract.default.tokens['font.body']);
  expect(await page.evaluate(async () => (await document.fonts.load('16px Cairo', 'اختيارات')).length)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm publication', exact: true }).click();
  await expect(page.getByText('New version published.', { exact: true })).toBeVisible();
  expect(published?.tokens['font.arabic.heading']).toBe('Tajawal');
  expect(fixture.errors).toEqual([]);
});
