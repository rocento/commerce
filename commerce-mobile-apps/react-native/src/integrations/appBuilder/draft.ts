import type { DesignAction, DesignColors, DesignSection, LocalizedCopy, StorefrontDesign } from '../../core/design';
type ObjectValue = Record<string, unknown>;
function object(v: unknown): ObjectValue { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid draft object'); return v as ObjectValue; }
function id(v: unknown): string { if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(v)) throw new Error('Invalid section identifier'); return v; }
function choice<T extends string>(v: unknown, values: readonly T[]): T { if (!values.includes(v as T)) throw new Error('Invalid section option'); return v as T; }
function palette(v: unknown): DesignColors { const p = object(v); return Object.fromEntries(['primary','onPrimary','background','surface','text'].map(k => { if (typeof p[k] !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(p[k])) throw new Error('Invalid theme colors'); return [k,p[k]]; })) as DesignColors; }
function action(v: unknown): DesignAction | undefined {
  if (v === undefined) return;
  const a = object(v);
  switch (a.type) {
    case 'openProduct': return { type: a.type, productId: id(a.productId) };
    case 'openCategory': return { type: a.type, categoryId: id(a.categoryId) };
    case 'openTab': return { type: a.type, tab: choice(a.tab, ['home','categories','deals','cart','account','wishlist']) };
    default: throw new Error('Invalid section action');
  }
}
export function designFromDraft(value: unknown, tenant: string): StorefrontDesign {
  const c = object(value);
  if (c.tenantId !== tenant || c.schemaVersion !== '1.0.0') throw new Error('Incompatible draft identity or schema');
  const brand = object(c.brand), messages = object(object(c.localization).messages);
  function text(key: unknown): LocalizedCopy {
    const k = id(key);
    return Object.fromEntries(['en','ar'].map(locale => { const value = object(messages[locale])[k]; if (typeof value !== 'string' || value.length > 20000) throw new Error('Missing section translation'); return [locale,value]; })) as LocalizedCopy;
  }
  const sections = object(object(c.screens).home).sections;
  if (!Array.isArray(sections) || !sections.length || sections.length > 30) throw new Error('Invalid sections');
  const seen = new Set<string>();
  const mapped = sections.map((value): DesignSection => {
    const s = object(value), p = object(s.props), sectionID = id(s.id);
    if (seen.has(sectionID)) throw new Error('Duplicate section identifier'); seen.add(sectionID);
    const base = { id: sectionID };
    switch (s.type) {
      case 'spacer': return { ...base, type: s.type, size: { small: 8, medium: 16, large: 32 }[choice(p.size, ['small','medium','large'])] };
      case 'productGrid': case 'productCarousel': {
        const limit = p.limit ?? 24;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 24) throw new Error('Invalid product limit');
        if (s.type === 'productGrid' && p.columns !== 1 && p.columns !== 2) throw new Error('Invalid columns');
        return { ...base, type: s.type, title: text(p.titleKey), collection: id(p.collectionId), columns: s.type === 'productGrid' ? p.columns as number : 1, limit };
      }
      case 'categoryGrid': {
        if (!Array.isArray(p.categoryIds) || p.categoryIds.length < 1 || p.categoryIds.length > 12 || new Set(p.categoryIds).size !== p.categoryIds.length) throw new Error('Invalid categories');
        return { ...base, type: s.type, title: text(p.titleKey), categories: p.categoryIds.map(id), appearance: choice(p.appearance ?? 'list', ['list','tiles']) };
      }
      case 'heroBanner': case 'richText': {
        if (p.storefrontPath !== undefined && (typeof p.storefrontPath !== 'string' || !/^\/(search|assistant|register|account|categories\/[a-zA-Z0-9_-]+)$/.test(p.storefrontPath) || p.storefrontPath.length > 160)) throw new Error('Invalid storefront destination');
        const editorial = { heading: p.headingKey === undefined ? undefined : text(p.headingKey), body: p.bodyKey === undefined ? undefined : text(p.bodyKey), eyebrow: p.eyebrowKey === undefined ? undefined : text(p.eyebrowKey), label: p.labelKey === undefined ? undefined : text(p.labelKey), appearance: p.appearance === undefined ? undefined : choice(p.appearance, ['editorial','campaign']), action: action(p.action), path: p.storefrontPath as string | undefined };
        if (s.type === 'richText') return { ...base, ...editorial, type: s.type, text: text(p.textKey) };
        if (typeof p.imageAssetId !== 'string' || !/^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(p.imageAssetId) || !editorial.action) throw new Error('Invalid hero image or action');
        const layout = p.layout === undefined ? undefined : choice(p.layout, ['horizontal','portrait']);
        const imageFit = p.imageFit === undefined ? undefined : choice(p.imageFit, ['cover','contain']);
        const additionalImages = p.additionalImageAssetIds ?? [];
        if (!Array.isArray(additionalImages) || additionalImages.length > 7 || new Set(additionalImages).size !== additionalImages.length || additionalImages.some(id => typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))) throw new Error('Invalid banner images');
        if ((layout || imageFit || p.additionalImageAssetIds !== undefined) && (object(c.compatibility).minIosRuntime !== '1.3.0' || object(c.compatibility).minAndroidRuntime !== '1.3.0')) throw new Error('Banner runtime required');
        return { ...base, ...editorial, type: s.type, image: p.imageAssetId, additionalImages: additionalImages as string[], layout, imageFit, accessibilityLabel: text(p.accessibilityLabelKey) };
      }
      default: throw new Error('Unsupported section type');
    }
  });
  const product = object(object(c.screens).product ?? {}), features = object(c.features);
  for (const key of ['showWishlist', 'showCompare']) {
    if (product[key] !== undefined && typeof product[key] !== 'boolean') throw new Error('Invalid product action visibility');
  }
  if (typeof features.wishlist !== 'boolean') throw new Error('Invalid wishlist feature');
  return { productActions: { wishlist: features.wishlist && product.showWishlist !== false, compare: product.showCompare !== false }, colors: palette(brand.light), darkColors: brand.dark === undefined ? undefined : palette(brand.dark), radius: { none: 0, small: 8, medium: 18, large: 28 }[choice(brand.radiusToken, ['none','small','medium','large'])], spacing: { compact: 12, comfortable: 20 }[choice(brand.density, ['compact','comfortable'])], sections: mapped };
}
