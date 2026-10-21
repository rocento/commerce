import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultTheme, validateTheme, themeContract } from './themes';

const preset = (name: string) => JSON.parse(readFileSync(new URL(`../../../../commerce-demo/${name}/theme.json`, import.meta.url), 'utf8'));
const resolve = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
  if (typeof value === 'string' && /^(asset|category):/.test(value)) return '11111111-1111-4111-8111-111111111111';
  if (typeof value === 'string' && value.startsWith('category-link:')) return '/categories/11111111-1111-4111-8111-111111111111';
  return value;
};
describe('demo preset contract compatibility', () => {
  for (const name of ['grocery', 'jewelry', 'electronics']) it(`${name} resolves to a valid existing-engine configuration`, () => {
    expect(validateTheme(resolve(preset(name)))).toEqual([]);
  });
  it('Grocery changes only its documented palette, without editorial opt-ins', () => {
    const expected = defaultTheme();
    // Demo-specific presentation guidance: commerce-docs/frontend/assets-and-demos.md.
    Object.assign(expected.tokens, {
      'color.primary': '#054828',
      'color.success': '#054828',
      'color.surface': '#F1F4F0',
    });
    const grocery = preset('grocery');
    expect(grocery).toEqual(expected);
    expect(grocery.global.top.some((s: { component: string }) => s.component === 'presentation')).toBe(false);
  });
  it('all new capabilities are optional and accept existing setting types', () => {
    for (const key of ['presentation', 'editorial_hero', 'image_text', 'product_collection', 'category_showcase']) {
      expect(themeContract.components[key].required).toBe(false);
      for (const property of Object.values(themeContract.components[key].settings)) expect(['text','select','asset','number','link']).toContain(property.kind);
    }
  });
  it('uses the reference palette and locally hosted font choices', () => {
    const config = preset('jewelry');
    expect(config.tokens['color.primary']).toBe('#083057');
    expect(config.tokens['color.secondary']).toBe('#bda160');
    expect(config.tokens['font.heading']).toBe('Futura Now Headline');
    expect(config.tokens['font.body']).toBe('Futura Now Headline');
    expect(config.global.top.find((s: {component:string}) => s.component === 'presentation').settings.style).toBe('heritage');
  });
  it('retains required commerce slots in both presets', () => {
    for (const name of ['grocery', 'jewelry', 'electronics']) {
      const config = preset(name);
      for (const [page, component] of Object.entries({category:'product_grid',search:'product_grid',product:'product_detail',cart:'cart'})) {
        expect(config.pages[page].filter((s: {component:string;enabled:boolean}) => s.component === component && s.enabled)).toHaveLength(1);
      }
    }
  });
});
