import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mobileConfigIssues, type MobileConfig } from '@commerce/api-client';
import { withSectionRuntime, appendLayout, duplicateSection, layoutPresets, sectionTextKey, updateSectionText } from './mobile-section-library';
const fixture = JSON.parse(readFileSync(new URL('../../../../commerce-api/rocento-api/crates/domain-mobile/contract/v1/fixtures/merchant-1.json', import.meta.url), 'utf8')) as MobileConfig;
const config = () => structuredClone(fixture);
const validate = (c: MobileConfig) => mobileConfigIssues(c, c.tenantId, { wishlist: true, locationPicker: true, reviews: true });
describe('Mobile component composition', () => {
  it.each(layoutPresets)('appends $name without replacing existing content and passes the native schema', preset => {
    const c = config(), next = appendLayout(c, preset.id);
    expect(next.screens.home.sections.slice(0, c.screens.home.sections.length)).toEqual(c.screens.home.sections);
    expect(next.screens.home.sections).toHaveLength(c.screens.home.sections.length + preset.sections.length);
    expect(validate(next)).toEqual([]);
    expect(c).toEqual(fixture);
  });
  it('duplicates adjacent to the original with independent text in every locale', () => {
    const c = config(), original = c.screens.home.sections[0], next = duplicateSection(c, original.id), duplicate = next.screens.home.sections[1];
    expect(duplicate.id).not.toBe(original.id);
    expect(sectionTextKey(duplicate)).not.toBe(sectionTextKey(original));
    expect(validate(next)).toEqual([]);
    const edited = updateSectionText(next, duplicate.id, 'ar', 'محتوى مستقل');
    expect(edited.localization.messages.ar![sectionTextKey(original)!]).toBe(c.localization.messages.ar![sectionTextKey(original)!]);
    expect(edited.localization.messages.ar![sectionTextKey(duplicate)!]).toBe('محتوى مستقل');
  });
  it('isolates shared translation references before inline edits', () => {
    const c = config(), original = c.screens.home.sections[0];
    c.screens.home.sections.push({ ...structuredClone(original), id: 'shared' });
    const next = updateSectionText(c, 'shared', 'en', 'Independent title');
    expect(sectionTextKey(next.screens.home.sections.at(-1)!)).not.toBe(sectionTextKey(original));
    expect(next.localization.messages.en![sectionTextKey(original)!]).toBe(c.localization.messages.en![sectionTextKey(original)!]);
    expect(validate(next)).toEqual([]);
  });
  it('enforces the section limit without partially applying a layout', () => {
    let c = config();
    while (c.screens.home.sections.length < 30) c = duplicateSection(c, c.screens.home.sections[0].id);
    expect(duplicateSection(c, c.screens.home.sections[0].id)).toBe(c);
    expect(appendLayout(c, 'campaign')).toBe(c);
    expect(validate(c)).toEqual([]);
  });
});

describe('Native runtime requirements', () => {
  it('preserves independent higher platform requirements when changing icons', () => {
    const c = config();
    c.compatibility = { minIosRuntime: '1.3.0', minAndroidRuntime: '1.2.0' };
    c.navigation.icons = { home: 'location' };
    expect(withSectionRuntime(c).compatibility).toEqual(c.compatibility);
  });
  it('raises both platform requirements for Deals and native banners', () => {
    const c = config();
    c.navigation.icons = { home: 'deals' };
    expect(withSectionRuntime(c).compatibility).toEqual({ minIosRuntime: '1.2.0', minAndroidRuntime: '1.2.0' });
    const banner = c.screens.home.sections.find(s => s.type === 'heroBanner')!;
    if (banner.type === 'heroBanner') banner.props.imageFit = 'contain';
    const next = withSectionRuntime(c);
    expect(next.compatibility).toEqual({ minIosRuntime: '1.3.0', minAndroidRuntime: '1.3.0' });
    expect(validate(next)).toEqual([]);
    expect(c.compatibility).toEqual(fixture.compatibility);
  });
  it('raises icon requirements without hiding unsupported runtime values', () => {
    const c = config();
    c.navigation.icons = { home: 'location' };
    c.compatibility.minIosRuntime = '2.0.0';
    const next = withSectionRuntime(c);
    expect(next.compatibility).toEqual({ minIosRuntime: '2.0.0', minAndroidRuntime: '1.1.0' });
    expect(validate(next).map(issue => issue.code)).toContain('UNSUPPORTED_RUNTIME');
  });
});

describe('Native section editing compatibility', () => {
  it('edits banner accessibility copy without replacing its editorial heading', () => {
    const c = config();
    const hero = c.screens.home.sections.find(s => s.type === 'heroBanner')!;
    if (hero.type !== 'heroBanner') throw new Error('Missing hero fixture');
    hero.props.headingKey = hero.props.accessibilityLabelKey;
    hero.props.appearance = 'editorial';
    const heading = hero.props.headingKey;
    const before = c.localization.messages.en![heading];
    const next = updateSectionText(c, hero.id, 'en', 'Fresh fruit on a wooden table');
    const edited = next.screens.home.sections.find(s => s.id === hero.id)!;
    if (edited.type !== 'heroBanner') throw new Error('Wrong component');
    expect(edited.props.headingKey).toBe(heading);
    expect(edited.props.accessibilityLabelKey).not.toBe(heading);
    expect(next.localization.messages.en![heading]).toBe(before);
    expect(next.localization.messages.en![edited.props.accessibilityLabelKey]).toBe('Fresh fruit on a wooden table');
    expect(validate(withSectionRuntime(next))).toEqual([]);
  });
  it('raises both native runtime minimums for product limits and banner layouts', () => {
    const c = config();
    const product = c.screens.home.sections.find(s => s.type === 'productGrid' || s.type === 'productCarousel')!;
    if (product.type !== 'productGrid' && product.type !== 'productCarousel') throw new Error('Missing product fixture');
    product.props.limit = 6;
    const editorial = withSectionRuntime(c);
    expect(editorial.compatibility).toEqual({ minIosRuntime: '1.2.0', minAndroidRuntime: '1.2.0' });
    expect(validate(editorial)).toEqual([]);
    const hero = c.screens.home.sections.find(s => s.type === 'heroBanner')!;
    if (hero.type !== 'heroBanner') throw new Error('Missing hero fixture');
    hero.props.layout = 'horizontal';
    hero.props.imageFit = 'contain';
    const banners = withSectionRuntime(c);
    expect(banners.compatibility).toEqual({ minIosRuntime: '1.3.0', minAndroidRuntime: '1.3.0' });
    expect(validate(banners)).toEqual([]);
    expect(c.compatibility).toEqual(fixture.compatibility);
  });
  it('preserves newer per-platform requirements when editing older components', () => {
    const c = config();
    c.compatibility = { minIosRuntime: '1.3.0', minAndroidRuntime: '1.2.0' };
    c.screens.home.layout = 'standard';
    expect(withSectionRuntime(c).compatibility).toEqual(c.compatibility);
    delete c.screens.home.layout;
    expect(withSectionRuntime(c).compatibility).toEqual(c.compatibility);
  });
});
