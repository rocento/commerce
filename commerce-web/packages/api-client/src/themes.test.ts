import { describe, expect, it } from 'vitest';
import { defaultTheme, safeThemeLink, themeAllowed, validateTheme } from './themes';
describe('theme contract', () => {
  it('accepts RTL and LTR, defaults legacy themes, and rejects invalid directions', () => {
    const config = defaultTheme();
    delete config.tokens['layout.direction'];
    expect(validateTheme(config)).toEqual([]);
    for (const direction of ['ltr', 'rtl']) {
      config.tokens['layout.direction'] = direction;
      expect(validateTheme(config)).toEqual([]);
    }
    for (const direction of ['auto', 'rtl;display:none', 1, null]) {
      config.tokens['layout.direction'] = direction;
      expect(validateTheme(config)).toContain('Tokens: layout.direction');
    }
  });
  it('accepts the reference theme', () => expect(validateTheme(defaultTheme())).toEqual([]));
  it('accepts legacy header options while rejecting invalid cart display values', async () => {
    const { themeContract } = await import('./themes');
    const config = defaultTheme();
    const settings = Object.fromEntries(Object.entries(themeContract.components.header_options.settings).map(([key, property]) => [key, property.default]));
    delete settings.cart_display;
    config.global.top.push({ id: 'header-options', component: 'header_options', version: 1, enabled: true, settings });
    expect(validateTheme(config)).toEqual([]);
    expect(settings).not.toHaveProperty('cart_display');
    settings.cart_display = 'invalid';
    expect(validateTheme(config)).toContain('Header options: cart_display');
  });
  it('rejects CSS and script injection', () => {
    const c = defaultTheme(); c.tokens['color.primary'] = '#fff;display:none';
    expect(validateTheme(c).length).toBeGreaterThan(0);
    for (const url of ['//evil.test','javascript:alert(1)','/%2fexample','/\\example']) expect(safeThemeLink(url)).toBe(false);
  });
  it('requires commerce components even if the editor is bypassed', () => {
    const c = defaultTheme(); c.pages.cart = [];
    expect(validateTheme(c)).toContain('cart: exactly one Cart required');
  });
  it('scopes permissions by operation and channel', () => {
    expect(themeAllowed(['theme.preview@a'], 'preview', 'b')).toBe(false);
    expect(themeAllowed(['theme.preview@a'], 'publish', 'a')).toBe(false);
    expect(themeAllowed(['theme.preview@a'], 'preview', 'a')).toBe(true);
  });
  it('returns errors instead of crashing on malformed sections and settings', () => {
    for (const section of [null, [], {}, { component: 'cart', settings: null }, { component: '__proto__', settings: {} }]) {
      const c = defaultTheme();
      const input = { ...c, pages: { ...c.pages, cart: [section] } };
      expect(() => validateTheme(input)).not.toThrow();
      expect(validateTheme(input).length).toBeGreaterThan(0);
    }
  });
  it('rejects unexpected fields and non-boolean visibility', () => {
    const c = defaultTheme();
    expect(validateTheme({ ...c, script: 'run()' })).toContain('Missing or unknown configuration fields');
    const section = c.pages.home[0];
    expect(validateTheme({ ...c, pages: { ...c.pages, home: [{ ...section, enabled: 'false' }] } })).toContain('Invalid section fields');
    expect(validateTheme({ ...c, pages: { ...c.pages, home: [{ ...section, module: '/evil.js' }] } })).toContain('Invalid section fields');
  });
  it('rejects mismatched versions, duplicate identifiers and absent alt text', () => {
    const c = defaultTheme();
    c.pages.home[0].version = 999;
    expect(validateTheme(c).length).toBeGreaterThan(0);
    const duplicate = defaultTheme();
    duplicate.pages.home.push(structuredClone(duplicate.pages.home[0]));
    expect(validateTheme(duplicate)).toContain('Section IDs must be unique');
    const image = defaultTheme();
    image.pages.home[0].settings.image = '11111111-1111-4111-8111-111111111111';
    expect(validateTheme(image)).toContain('Hero: image alt text required');
  });
  it('rejects oversized content and invalid responsive tokens', () => {
    const c = defaultTheme();
    c.pages.home[0].settings.text = 'x'.repeat(130 * 1024);
    expect(validateTheme(c)).toContain('Configuration exceeds 128 KiB');
    const tokens = defaultTheme();
    tokens.tokens['breakpoint.mobile'] = 1500;
    expect(validateTheme(tokens)).toContain('Breakpoints must increase');
  });
});

describe('storefront layout options', () => {
  it('accepts independent category/search filters and preserves legacy global filters', async () => {
    const { themeContract } = await import('./themes');
    const config = defaultTheme();
    const section = (id: string, layout: string) => ({ id, component: 'catalog_filters', version: 1, enabled: true, settings: { layout } });
    config.global.top.push(section('legacy-filter', 'vertical'));
    config.pages.category.push(section('category-filter', 'horizontal'));
    config.pages.search.push(section('search-filter', 'vertical'));
    expect(validateTheme(config)).toEqual([]);
    config.pages.category.at(-1)!.settings.layout = 'diagonal';
    expect(validateTheme(config)).toContain(`${themeContract.components.catalog_filters.label}: layout`);
  });
  it('validates header assets and footer destinations', async () => {
    const { themeContract } = await import('./themes');
    const config = defaultTheme();
    for (const [component, location] of [['header_options', 'top'], ['footer_options', 'bottom']] as const) {
      config.global[location].push({ id: component.replaceAll('_', '-'), component, version: 1, enabled: true, settings: Object.fromEntries(Object.entries(themeContract.components[component].settings).map(([key,p]) => [key,p.default])) });
    }
    expect(validateTheme(config)).toEqual([]);
    config.global.top.at(-1)!.settings.image = '11111111-1111-4111-8111-111111111111';
    config.global.top.at(-1)!.settings.alt = '';
    config.global.bottom.at(-1)!.settings.column_1_link_1_href = '//untrusted.example';
    expect(validateTheme(config)).toContain('Header options: image alt text required');
    expect(validateTheme(config)).toContain('Footer content & links: column_1_link_1_href');
  });
});

it('allows best sellers with bounded periods and counts in merchant themes', () => {
  const theme = defaultTheme();
  const section = { id: 'best-sellers', component: 'best_sellers', version: 1, enabled: true, settings: { heading: 'Best sellers', period: 'last_month', limit: 8 } };
  theme.pages.home.push(section);
  expect(validateTheme(theme)).toEqual([]);
  section.settings.period = 'invented';
  expect(validateTheme(theme).length).toBeGreaterThan(0);
  section.settings.period = 'today';
  section.settings.limit = 25;
  expect(validateTheme(theme).length).toBeGreaterThan(0);
});
