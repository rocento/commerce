import { test, expect, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { components } from '../../packages/api-client/src/schema';
const id = '11111111-1111-4111-8111-111111111111';
const categories = [{ id, name: 'Fresh Vegetables', slug: 'fresh-vegetables', parent_id: null }, { id: 'fruit', name: 'Fresh Fruit', slug: 'fresh-fruit', parent_id: null }, { id: 'child', name: 'Tomatoes', slug: 'tomatoes', parent_id: id }];
const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
async function setup(context: BrowserContext, permissions = ['*'], sourceLocale = 'en') {
  const languages: {locale:string;name:string;native_name:string;direction:string;revision:number}[] = sourceLocale === 'ar' ? [] : [{locale:'ar',name:'Arabic',native_name:'العربية',direction:'rtl',revision:1}];
  let document: components['schemas']['ContentDocument'] | null = null;
  let revision: components['schemas']['ContentRevision'] | null = null;
  let published: components['schemas']['PublishedContent'] = null;
  let saves = 0;
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body: unknown = [];
    if (path.endsWith('/admin/me')) body = { user: { id, name: 'Menu editor', email: 'editor@example.test' }, permissions };
    else if (path.endsWith('/admin/languages')) {
      if(method==='POST') {
        const input=route.request().postDataJSON();
        expect(input).toMatchObject({locale:'ar',name:'Arabic',native_name:'العربية',direction:'rtl',expected_revision:0});
        const language={locale:input.locale,name:input.name,native_name:input.native_name,direction:input.direction,revision:1};
        languages.push(language);body=language;
      } else body={source_locale:sourceLocale,languages,publication_available:true};
    }
    else if (path.includes('/languages/ar/translations/navigation/')) {
      if (!revision) throw new Error('Save a navigation revision before translating it');
      const source:Record<string,string>={title:revision.title,__version:String(revision.version)};
      revision.blocks.forEach((block,index)=>{source[`item.${index}.label`]=block.link_label;});
      body={entity_id:id,name:revision.title,source,fields:{},revision:0,status:'missing'};
    }
    else if (path.endsWith('/languages')) body = { source_locale: 'en', languages: [] };
    else if (path.endsWith('/admin/markets')) body = { items: [], live: { region: 'EG', currency: 'EGP' }, locales: ['en'], activation_available: false };
    else if (path.endsWith('/categories')) body = categories;
    else if (path.endsWith('/admin/content')) {
      if (method === 'POST') {
        const input: components['schemas']['ContentInput'] = route.request().postDataJSON();
        expect(input.expected_version).toBe(document?.version ?? 0);
        saves++;
        document = { id, entity_id: 1, key: input.key, kind: input.kind, version: saves, updated_at: new Date().toISOString() };
        revision = { id: `revision-${saves}`, entity_id: saves, document_id: id, version: saves, title: input.title, blocks: input.blocks, created_by: id, created_at: new Date().toISOString() };
        body = { document_id: id, revision_id: revision.id, version: saves };
      } else body = document ? [document] : [];
    } else if (path.endsWith(`/admin/content/${id}`)) body = { document, revisions: [revision], releases: [] };
    else if (path.endsWith(`/admin/content/${id}/releases`)) {
      if (!revision) throw new Error('Save a navigation revision before publishing it');
      published = { key: 'navigation', title: revision.title, version: revision.version, blocks: structuredClone(revision.blocks) }; body = { status: 'ok' };
    }
    else if (path.includes('/grids/cms-revisions')) body = { items: revision ? [revision] : [], total_count: revision ? 1 : 0, next_cursor: null };
    else if (path.includes('/grids/')) body = { items: [], total_count: 0, next_cursor: null };
    else if (path.endsWith('/content/navigation')) body = published;
    else if (path.includes('/content/')) body = null;
    else if (path.endsWith('/customer/auth/refresh')) return route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
    else if (path.includes('/theme/')) body = { configuration: theme, cities: [] };
    else if (path.endsWith('/search')) body = { hits: [], total: 0, offset: 0, limit: 20, facets: {} };
    else if (path.endsWith('/cart')) body = { id, items: [], subtotal: '0', total: '0', currency: 'EGP' };
    await route.fulfill({ json: body });
  });
  return { saves: () => saves, published: () => published };
}
test('category bar becomes an editable draft and changes reach the storefront only after publication', async ({ page, context }, info) => {
  const state = await setup(context);
  const storefront = await context.newPage();
  await storefront.goto('http://127.0.0.1:5185/search');
  const bar = storefront.getByRole('navigation', { name: 'Shop navigation', exact: true });
  await expect(bar.getByRole('link')).toHaveText(['Shop all', 'Fresh Vegetables', 'Fresh Fruit']);
  await page.goto('/content/navigation');
  await page.getByRole('button', {name:/Fresh Vegetables.*Direct link/}).click();
  await page.getByLabel('Label', { exact: true }).fill('Vegetables & greens');
  const vegetables = page.locator('.menu-item-detail > fieldset');
  await vegetables.getByRole('button', { name: 'Add dropdown link', exact: true }).click();
  await vegetables.getByLabel('Link label', { exact: true }).fill('Tomatoes');
  await vegetables.getByLabel('Column heading', { exact: true }).fill('Fresh produce');
  await vegetables.getByLabel('Destination', { exact: true }).fill('/categories/tomatoes');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply release', exact: true })).toBeEnabled();
  await storefront.reload();
  await expect(bar.getByRole('link', { name: 'Fresh Vegetables', exact: true })).toBeVisible();
  expect(state.published()).toBeNull();
  await page.getByRole('button', { name: 'Apply release', exact: true }).click();
  await expect.poll(state.published).not.toBeNull();
  await storefront.reload();
  const trigger = bar.getByRole('button', { name: 'Vegetables & greens', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(bar.getByRole('link', { name: 'Explore all →', exact: true })).toHaveAttribute('href', '/categories/fresh-vegetables?lang=en');
  await expect(bar.getByRole('link', { name: 'Tomatoes', exact: true })).toHaveAttribute('href', '/categories/tomatoes?lang=en');
  await storefront.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(bar.getByRole('link', { name: 'Fresh Vegetables', exact: true })).toHaveCount(0);
  await storefront.screenshot({ path: info.outputPath('published-category-bar.png'), fullPage: true });
  await storefront.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(bar.getByRole('link', { name: 'Tomatoes', exact: true })).toBeVisible();
  expect(await storefront.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await storefront.close();
});
test('unsafe destinations and an all-hidden menu cannot be saved', async ({ page, context }) => {
  const state = await setup(context);
  await page.goto('/content/navigation');
  await page.getByLabel('Destination', { exact: true }).fill('javascript:alert(1)');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('secure https:// URL');
  await page.getByLabel('Destination', { exact: true }).fill('/search');
  for (const item of await page.locator('.menu-outline-item').all()) { await item.click(); await page.getByLabel('Visible', {exact:true}).uncheck(); }
  await expect(page.getByRole('alert')).toContainText('Make at least one menu item visible');
  expect(state.saves()).toBe(0);
});
test('read-only users can inspect the connection without editing or publishing', async ({ page, context }) => {
  await setup(context, ['cms.read']);
  await page.goto('/content/navigation');
  await expect(page.getByRole('region', { name: 'Menu publication status' })).toContainText('Catalog category bar is active');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply release', exact: true })).toHaveCount(0);
});

test('configured Arabic activates after saving the source draft without a separate language panel', async ({ page, context }) => {
  await setup(context);
  await page.goto('/content/navigation');
  await expect(page.getByText('Languages & translations', {exact:true})).toHaveCount(0);
  await expect(page.getByLabel('Content language').locator('option[value="ar"]')).toHaveAttribute('disabled','');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByLabel('Content language').locator('option[value="ar"]')).not.toHaveAttribute('disabled','');
  await page.getByLabel('Content language').selectOption('ar');
  await expect(page.getByRole('heading', { name: 'Arabic content', exact: true })).toBeVisible();
  await page.getByLabel('Use source value for label', { exact: true }).uncheck();
  const field=page.getByLabel('Label · Arabic', { exact: true });
  await field.fill('تسوق الكل');
  await expect(field).toHaveAttribute('dir','rtl');
  await expect(page.getByRole('button', { name: 'Save translation draft', exact: true })).toBeEnabled();
});
test('Arabic source remains editable as the default language', async ({ page, context }) => {
  await setup(context, ['*'],'ar');
  await page.goto('/content/navigation');
  await expect(page.getByLabel('Content language').locator('option[value=""]')).toHaveText('Arabic (ar) · Source / default');
  await expect(page.getByRole('button', {name:'Save draft',exact:true})).toBeVisible();
});
