import { describe, expect, it } from 'vitest';
import { designFromDraft } from './draft';
const tenant = '312f9ac8-4888-4d35-92a0-e5fdb3bf59b8';
const draft = () => ({ tenantId: tenant, schemaVersion: '1.0.0', features: { wishlist: true }, brand: { light: { primary: '#123456', onPrimary: '#FFFFFF', background: '#FFFFFF', surface: '#EEEEEE', text: '#111111' }, radiusToken: 'medium', density: 'compact' }, screens: { home: { sections: [{ id: 'copy', type: 'richText', props: { textKey: 'copy' } }] } }, localization: { messages: { en: { copy: 'Hello' }, ar: { copy: 'مرحبا' } } } });
describe('Studio draft mapping', () => {
  it('maps bilingual text and shared tokens into native presentation data', () => {
    expect(designFromDraft(draft(), tenant)).toMatchObject({ radius: 18, spacing: 12, colors: { primary: '#123456' }, sections: [{ text: { en: 'Hello', ar: 'مرحبا' } }] });
  });
  it('rejects cross-tenant drafts', () => expect(() => designFromDraft(draft(), 'another')).toThrow());
  it('rejects unsupported sections instead of acknowledging an incomplete rendering', () => {
    const value = draft(); value.screens.home.sections[0]!.type = 'unknown';
    expect(() => designFromDraft(value, tenant)).toThrow('Unsupported section type');
  });
  it('rejects invalid token values', () => { const value = draft(); value.brand.light.primary = 'red'; expect(() => designFromDraft(value, tenant)).toThrow(); });
});

it('maps every Builder section and editorial destinations in order', () => {
  const value = draft();
  const sections = [
    { id: 'hero', type: 'heroBanner', props: { imageAssetId: '11111111-1111-1111-1111-111111111111', accessibilityLabelKey: 'copy', action: { type: 'openTab', tab: 'categories' }, appearance: 'campaign', headingKey: 'copy', storefrontPath: '/search' } },
    { id: 'grid', type: 'productGrid', props: { titleKey: 'copy', collectionId: 'fruit', columns: 2, limit: 3 } },
    { id: 'carousel', type: 'productCarousel', props: { titleKey: 'copy', collectionId: 'demo-feed-fresh' } },
    { id: 'categories', type: 'categoryGrid', props: { titleKey: 'copy', categoryIds: ['fruit'], appearance: 'tiles' } },
    ...value.screens.home.sections,
    { id: 'space', type: 'spacer', props: { size: 'large' } },
  ];
  const result = designFromDraft({ ...value, screens: { home: { sections } } }, tenant);
  expect(result.sections.map(s => s.type)).toEqual(['heroBanner','productGrid','productCarousel','categoryGrid','richText','spacer']);
  expect(result.sections[0]).toMatchObject({ heading: { en: 'Hello', ar: 'مرحبا' }, path: '/search', appearance: 'campaign' });
  expect(result.sections[1]).toMatchObject({ columns: 2, limit: 3 });
  expect(result.sections[5]).toMatchObject({ size: 32 });
});
it.each([
  { type: 'productGrid', props: { titleKey: 'copy', collectionId: 'fruit', columns: 3 } },
  { type: 'categoryGrid', props: { titleKey: 'copy', categoryIds: ['fruit','fruit'] } },
  { type: 'richText', props: { textKey: 'copy', storefrontPath: 'https://untrusted.example' } },
  { type: 'richText', props: { textKey: 'missing' } },
  { type: 'spacer', props: { size: 'huge' } },
])('rejects invalid section props before acknowledgement: $type', section => {
  const value = draft();
  expect(() => designFromDraft({ ...value, screens: { home: { sections: [{ id: 'bad', ...section }] } } }, tenant)).toThrow();
});

it('maps product visibility independently and respects wishlist availability', () => {
  const value = draft();
  expect(designFromDraft(value, tenant).productActions).toEqual({ wishlist: true, compare: true });
  expect(designFromDraft({ ...value, screens: { ...value.screens, product: { showWishlist: false, showCompare: false } } }, tenant).productActions).toEqual({ wishlist: false, compare: false });
  expect(designFromDraft({ ...value, features: { wishlist: false }, screens: { ...value.screens, product: { showWishlist: true } } }, tenant).productActions).toEqual({ wishlist: false, compare: true });
  expect(() => designFromDraft({ ...value, screens: { ...value.screens, product: { showCompare: 'false' } } }, tenant)).toThrow('Invalid product action visibility');
});

it('maps banner shapes and bounded galleries and requires runtime 1.3', () => {
  const value = { ...draft(), compatibility: { minIosRuntime: '1.3.0', minAndroidRuntime: '1.3.0' }, screens: { home: { sections: [{ id: 'banner', type: 'heroBanner', props: { layout: 'portrait', imageFit: 'contain', imageAssetId: '11111111-1111-1111-1111-111111111111', additionalImageAssetIds: ['22222222-2222-2222-2222-222222222222'], accessibilityLabelKey: 'copy', action: { type: 'openTab', tab: 'home' } } }] } } };
  expect(designFromDraft(value,tenant).sections[0]).toMatchObject({layout:'portrait',imageFit:'contain',additionalImages:['22222222-2222-2222-2222-222222222222']});
  value.compatibility.minIosRuntime='1.2.0';expect(()=>designFromDraft(value,tenant)).toThrow('Banner runtime');
  value.compatibility.minIosRuntime='1.3.0';value.screens.home.sections[0]!.props.additionalImageAssetIds=Array(8).fill('22222222-2222-2222-2222-222222222222');
  expect(()=>designFromDraft(value,tenant)).toThrow('Invalid banner images');
});
