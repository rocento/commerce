import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { CatalogImage, Category, Product } from '../../packages/api-client/src/catalog';
const themeContract = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8'));
const theme = themeContract.default;
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/customer/auth/refresh', route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/v1/theme/*', route => route.fulfill({ json: { configuration: theme, cities: [] } }));
  await page.route('**/api/v1/content/*', route => route.fulfill({ json: { key: 'quality', title: 'Quality content', blocks: [] } }));
  await page.route('**/api/v1/search?*', route => route.fulfill({ json: { hits: [], total: 0, offset: 0, limit: 20, facets: {} } }));
  await page.route('**/api/v1/cart', route => route.fulfill({ json: { id: '11111111-1111-4111-8111-111111111111', items: [], subtotal: '0.00', total: '0.00', currency: 'USD' } }));
});
for (const path of ['/account', '/account/wishlist', '/account/orders', '/account/locations/new', '/account/tickets']) {
  test(`QA-SF-guest ${path} redirects to login and survives refresh`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
test('QA-SF-404 unknown route offers working home navigation', async ({ page }) => {
  await page.goto('/quality-unknown-route');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return home', exact: true })).toHaveAttribute('href', '/');
});

test('category sections share one count request and rank before applying display limits', async ({ page }) => {
  const categories = [
    { id: '00000000-0000-4000-8000-000000000001', name: 'Early empty', slug: 'early-empty', parent_id: null, thumbnail: null, banner: null },
    { id: '00000000-0000-4000-8000-000000000002', name: 'Middle', slug: 'middle', parent_id: null, thumbnail: null, banner: null },
    { id: '00000000-0000-4000-8000-000000000003', name: 'Late winner', slug: 'late-winner', parent_id: null, thumbnail: null, banner: null },
  ];
  const configuration = structuredClone(theme);
  const grid = configuration.pages.home.find((section: {component:string}) => section.component === 'category_grid');
  grid.settings.limit = 2;
  configuration.pages.home.push({ id: 'second-categories', component: 'category_showcase', version: 1, enabled: true, settings: { heading: 'More categories', limit: 2 } });
  await page.route('**/api/v1/theme/*', route => route.fulfill({ json: { configuration, cities: [] } }));
  await page.route('**/api/v1/catalog/categories*', route => route.fulfill({ json: categories }));
  let countRequests = 0;
  let perCategorySearches = 0;
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/search' && url.searchParams.has('category_id')) perCategorySearches++;
  });
  await page.route('**/api/v1/catalog/category-availability', route => {
    countRequests++;
    return route.fulfill({ json: { [categories[0].id]: 0, [categories[1].id]: 9, [categories[2].id]: 25 } });
  });
  await page.goto('/');
  for (const heading of ['Shop by category', 'More categories']) {
    const links = page.getByRole('navigation', { name: heading, exact: true }).getByRole('link');
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute('href', `/categories/${categories[2].id}`);
    await expect(links.nth(1)).toHaveAttribute('href', `/categories/${categories[1].id}`);
  }
  expect(countRequests).toBe(1);
  expect(perCategorySearches).toBe(0);
});

const jewelryImages = {
  hero: '00000000-0000-4000-8000-000000000101',
  product: '00000000-0000-4000-8000-000000000102',
  category: '00000000-0000-4000-8000-000000000103',
};
const jewelryImagePath = (id: string) => `/api/v1/catalog/media/${id}/content`;

async function mockJewelry(page: Page, includeMetadata = true) {
  const images: Record<string, CatalogImage> = Object.fromEntries(Object.values(jewelryImages).map(id => [id, {
    id, alt: 'Jewelry photograph', width: 1024, height: 1024,
    variants: [{ width: 480, height: 480 }, { width: 960, height: 960 }],
  }]));
  const section = (id: string, component: string, settings: Record<string, unknown>) => ({
    id, component, version: 1, enabled: true,
    settings: { ...Object.fromEntries(Object.entries(themeContract.components[component].settings).map(([key, property]) => [key, (property as { default: unknown }).default])), ...settings },
  });
  const configuration = structuredClone(theme);
  configuration.tokens['color.primary'] = '#073b56';
  configuration.tokens['color.secondary'] = '#e2c785';
  configuration.tokens['color.background'] = '#ffffff';
  configuration.tokens['color.text'] = '#2a2826';
  configuration.global.top.push(section('jewelry-presentation', 'presentation', { style: 'heritage' }));
  configuration.pages.home = [
    section('jewelry-hero', 'editorial_hero', { heading: 'Jewelry for every day', image: jewelryImages.hero, alt: 'Gold solitaire ring', label: 'Shop jewelry', href: '/search' }),
    section('jewelry-categories', 'category_showcase', { heading: 'Jewelry categories', limit: 2 }),
    section('jewelry-products', 'featured_products', { heading: 'Jewelry favorites', limit: 2 }),
  ];
  const category: Category = {
    id: '00000000-0000-4000-8000-000000000201', name: 'Rings', slug: 'jewelry-rings', parent_id: null,
    thumbnail: jewelryImages.category, banner: null,
    ...(includeMetadata ? { images: { [jewelryImages.category]: images[jewelryImages.category] } } : {}),
  };
  const product: Product = {
    id: '00000000-0000-4000-8000-000000000202', sku: 'JEWELRY-RING', slug: 'gold-solitaire', name: 'Gold solitaire',
    description: 'A gold solitaire ring.', price: '95.00', currency: 'USD', unit: 'each', category_id: category.id,
    attributes: {}, media_ids: [jewelryImages.product], active: true, in_stock: true, updated_at: '2026-10-03T00:00:00Z',
    product_type: 'simple', parent_id: null, variant_attributes: {}, attribute_set_id: null,
    ...(includeMetadata ? { images: { [jewelryImages.product]: images[jewelryImages.product] } } : {}),
  };
  await page.route('**/api/v1/languages', route => route.fulfill({ json: { source_locale: 'en', languages: [] } }));
  await page.route('**/api/v1/languages/interface', route => route.fulfill({ json: { revision: 1, catalog_version: 'quality', messages: [], overrides: [] } }));
  await page.route('**/api/v1/theme/*', route => route.fulfill({ json: {
    configuration, cities: [], ...(includeMetadata ? { images: { [jewelryImages.hero]: images[jewelryImages.hero] } } : {}),
  } }));
  await page.route('**/api/v1/catalog/categories*', route => route.fulfill({ json: [category] }));
  await page.route('**/api/v1/catalog/category-availability', route => route.fulfill({ json: { [category.id]: 1 } }));
  await page.route('**/api/v1/search?*', route => route.fulfill({ json: { hits: [product], total: 1, offset: 0, limit: 20, facets: {} } }));
  const imageRequests: string[] = [];
  await page.route('**/api/v1/catalog/media/*/content*', route => {
    const url = new URL(route.request().url());
    imageRequests.push(url.pathname + url.search);
    const width = Number(url.searchParams.get('width') || 1024);
    return route.fulfill({ contentType: 'image/svg+xml', body: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}"><rect width="100%" height="100%" fill="#f6f3ed"/><circle cx="${width / 2}" cy="${width / 2}" r="${width / 4}" fill="none" stroke="#ad8539" stroke-width="${width / 20}"/></svg>`) });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /theme_render_failure|theme_resolution_failure/.test(message.text())) errors.push(message.text());
  });
  return { product, imageRequests, errors };
}

test('the charset stays before the home warmup within the first 1024 bytes', async ({ request }) => {
  const response = await request.get('/');
  expect(response.ok()).toBe(true);
  const html = await response.text();
  const charset = html.search(/<meta\s+charset=/i);
  const warmup = html.indexOf('<script id="storefront-theme-warmup">');
  expect(charset).toBeGreaterThanOrEqual(0);
  expect(Buffer.byteLength(html.slice(0, charset), 'utf8')).toBeLessThan(1024);
  expect(warmup).toBeGreaterThan(charset);
});

test.describe('jewelry mobile image delivery', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1.75 });

  test('preload reuses the hero rendition, smaller cards use variants, and prices remain readable', async ({ page }) => {
    const { product, imageRequests, errors } = await mockJewelry(page);
    await page.goto('/');
    const hero = page.getByRole('img', { name: 'Gold solitaire ring', exact: true });
    await expect(hero).toBeVisible();
    await expect.poll(() => hero.evaluate(image => (image as HTMLImageElement).currentSrc)).toContain(`${jewelryImagePath(jewelryImages.hero)}?width=960`);
    await expect(hero).toHaveAttribute('alt', 'Gold solitaire ring');
    await expect(hero).toHaveAttribute('loading', 'eager');
    await expect(hero).toHaveAttribute('fetchpriority', 'high');
    await expect(hero).toHaveAttribute('width', '1024');
    await expect(hero).toHaveAttribute('height', '1024');
    const preload = page.locator(`link[rel="preload"][as="image"][href="${jewelryImagePath(jewelryImages.hero)}"]`);
    await expect(preload).toHaveCount(1);
    const normalizeSources = (value: string | null) => value?.split(',').map(candidate => {
      const [src, width] = candidate.trim().split(/\s+/);
      return `${new URL(src, page.url()).href} ${width}`;
    });
    expect(normalizeSources(await preload.getAttribute('imagesrcset'))).toEqual(normalizeSources(await hero.getAttribute('srcset')));
    expect(await preload.getAttribute('imagesizes')).toBe(await hero.getAttribute('sizes'));

    const category = page.getByRole('navigation', { name: 'Jewelry categories', exact: true }).locator('img');
    await category.scrollIntoViewIfNeeded();
    await expect.poll(() => category.evaluate(image => (image as HTMLImageElement).currentSrc)).toContain(`${jewelryImagePath(jewelryImages.category)}?width=480`);
    await expect(category).toHaveAttribute('alt', '');
    await expect(category).toHaveAttribute('loading', 'lazy');
    await expect(category).toHaveAttribute('width', '1024');
    await expect(category).toHaveAttribute('height', '1024');

    const card = page.locator('.product-card').filter({ has: page.getByRole('heading', { name: product.name, exact: true }) });
    const cardImage = card.getByRole('img', { name: product.name, exact: true });
    await cardImage.scrollIntoViewIfNeeded();
    await expect.poll(() => cardImage.evaluate(image => (image as HTMLImageElement).currentSrc)).toContain(`${jewelryImagePath(jewelryImages.product)}?width=480`);
    await expect(cardImage).toHaveAttribute('loading', 'lazy');
    await expect(cardImage).toHaveAttribute('width', '1024');
    await expect(cardImage).toHaveAttribute('height', '1024');
    const price = card.locator('.product-price-current');
    const metrics = await price.evaluate(element => {
      const style = getComputedStyle(element);
      let background = 'rgb(255, 255, 255)';
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const color = getComputedStyle(ancestor).backgroundColor;
        if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = color; break; }
      }
      const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
        const channel = Number(value) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      const foreground = luminance(style.color), backdrop = luminance(background);
      return { contrast: (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05), fontSize: parseFloat(style.fontSize) };
    });
    expect(metrics.contrast).toBeGreaterThanOrEqual(4.5);
    expect(metrics.fontSize).toBeGreaterThanOrEqual(14);
    expect(imageRequests.filter(path => path.startsWith(jewelryImagePath(jewelryImages.hero)))).toEqual([`${jewelryImagePath(jewelryImages.hero)}?width=960`]);
    for (const id of Object.values(jewelryImages)) expect(imageRequests).not.toContain(jewelryImagePath(id));
    expect(errors).toEqual([]);
  });

  test('legacy media without metadata preserves originals and does not invent dimensions', async ({ page }) => {
    const { product, imageRequests, errors } = await mockJewelry(page, false);
    await page.goto('/');
    const hero = page.getByRole('img', { name: 'Gold solitaire ring', exact: true });
    const category = page.getByRole('navigation', { name: 'Jewelry categories', exact: true }).locator('img');
    const productImage = page.getByRole('img', { name: product.name, exact: true });
    for (const [image, id] of [[hero, jewelryImages.hero], [category, jewelryImages.category], [productImage, jewelryImages.product]] as const) {
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).currentSrc)).toContain(jewelryImagePath(id));
      await expect(image).not.toHaveAttribute('srcset');
      await expect(image).not.toHaveAttribute('width');
      await expect(image).not.toHaveAttribute('height');
    }
    await expect(hero).toHaveAttribute('loading', 'eager');
    await expect(category).toHaveAttribute('loading', 'lazy');
    await expect(productImage).toHaveAttribute('loading', 'lazy');
    expect(imageRequests.filter(path => path.startsWith(jewelryImagePath(jewelryImages.hero)))).toEqual([jewelryImagePath(jewelryImages.hero)]);
    expect(imageRequests.every(path => !path.includes('?width='))).toBe(true);
    expect(errors).toEqual([]);
  });
});
