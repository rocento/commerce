import type { MobileConfig, MobileSection } from '@commerce/api-client';
import { appendSection } from './mobile-studio-model';

export const SECTION_LIMIT = 30;
export const componentCatalog: Record<MobileSection['type'], { group: string; description: string; icon: string }> = {
  heroBanner: { group: 'Campaigns', description: 'An accessible image with a native product, category or tab destination.', icon: 'banner' },
  productGrid: { group: 'Commerce', description: 'A collection in a one- or two-column product layout.', icon: 'grid' },
  productCarousel: { group: 'Commerce', description: 'A horizontally browsable collection for product discovery.', icon: 'carousel' },
  categoryGrid: { group: 'Commerce', description: 'Quick category discovery with up to 12 destinations.', icon: 'categories' },
  richText: { group: 'Content', description: 'Localized editorial copy, introductions and campaign messages.', icon: 'text' },
  spacer: { group: 'Content', description: 'Native spacing to separate content and establish rhythm.', icon: 'space' },
};
export const layoutPresets = [
  { id: 'discovery', name: 'Store discovery', description: 'Introduce your store, guide shoppers to categories, then showcase a collection.', sections: ['richText', 'categoryGrid', 'productCarousel'], en: ['Welcome to our store', 'Shop by category', 'Discover our favorites'], ar: ['مرحباً بكم في متجرنا', 'تسوق حسب الفئة', 'اكتشف مختاراتنا'] },
  { id: 'campaign', name: 'Campaign landing', description: 'A campaign hero, editorial message and product grid with breathing room.', sections: ['heroBanner', 'richText', 'spacer', 'productGrid'], en: ['Explore the latest collection', 'Find your next favorite', '', 'Shop the collection'], ar: ['اكتشف أحدث مجموعة', 'اكتشف منتجك المفضل القادم', '', 'تسوق المجموعة'] },
  { id: 'editorial', name: 'Collection story', description: 'Connect a brand story to a curated carousel and category discovery.', sections: ['richText', 'productCarousel', 'categoryGrid'], en: ['Made for your everyday', 'Selected for you', 'Explore more'], ar: ['مصمم لحياتك اليومية', 'مختارات لك', 'اكتشف المزيد'] },
] as const;
export function sectionTextKey(section: MobileSection): string | undefined {
  const p = section.props;
  return 'titleKey' in p ? p.titleKey : 'textKey' in p ? p.textKey : 'accessibilityLabelKey' in p ? p.accessibilityLabelKey : undefined;
}
export function sectionTitle(config: MobileConfig, section: MobileSection) {
  const key = 'headingKey' in section.props && section.props.headingKey ? section.props.headingKey : sectionTextKey(section);
  return key ? config.localization.messages[config.localization.defaultLocale]?.[key] || '' : '';
}
function setTextKey(section: MobileSection, key: string) {
  const p = section.props;
  if ('titleKey' in p) p.titleKey = key;
  else if ('textKey' in p) p.textKey = key;
  else if ('accessibilityLabelKey' in p) p.accessibilityLabelKey = key;
}
export function duplicateSection(config: MobileConfig, id: string): MobileConfig {
  if (config.screens.home.sections.length >= SECTION_LIMIT) return config;
  const index = config.screens.home.sections.findIndex(s => s.id === id);
  if (index < 0) return config;
  const copy = structuredClone(config), section = structuredClone(copy.screens.home.sections[index]);
  section.id = `section_${crypto.randomUUID().slice(0, 8)}`;
  for (const field of ['titleKey','textKey','accessibilityLabelKey','headingKey','bodyKey','eyebrowKey','labelKey']) {
    const props = section.props as unknown as Record<string,string>;
    const oldKey = props[field];
    if (oldKey) {
      const key = `${section.id}_${field}`; props[field] = key;
      for (const messages of Object.values(copy.localization.messages)) if (messages && oldKey in messages) messages[key] = messages[oldKey];
    }
  }
  copy.screens.home.sections.splice(index + 1, 0, section);
  return copy;
}
export function updateSectionText(config: MobileConfig, id: string, locale: 'en' | 'ar', value: string): MobileConfig {
  const copy = structuredClone(config), section = copy.screens.home.sections.find(s => s.id === id);
  if (!section) return config;
  const oldKey = sectionTextKey(section);
  if (!oldKey) return config;
  // Isolate text shared with another component before editing it locally.
  const fields = ['titleKey', 'textKey', 'accessibilityLabelKey', 'headingKey', 'bodyKey', 'eyebrowKey', 'labelKey'];
  const shared = copy.screens.home.sections.flatMap(s => Object.entries(s.props))
    .filter(([field, value]) => fields.includes(field) && value === oldKey).length > 1;
  const key = shared ? `${section.id}_copy_${crypto.randomUUID().slice(0, 8)}` : oldKey;
  if (shared) {
    setTextKey(section, key);
    for (const messages of Object.values(copy.localization.messages)) {
      if (messages && oldKey in messages) messages[key] = messages[oldKey];
    }
  }
  copy.localization.messages[locale] = { ...copy.localization.messages[locale], [key]: value };
  return copy;
}
export function appendLayout(config: MobileConfig, presetId: string): MobileConfig {
  const preset = layoutPresets.find(p => p.id === presetId);
  if (!preset || config.screens.home.sections.length + preset.sections.length > SECTION_LIMIT) return config;
  let copy = config;
  preset.sections.forEach((type, index) => {
    copy = appendSection(copy, type);
    const section = copy.screens.home.sections.at(-1)!;
    const key = sectionTextKey(section);
    if (key) {
      copy.localization.messages.en![key] = preset.en[index];
      copy.localization.messages.ar![key] = preset.ar[index];
    }
  });
  return copy;
}

export function updateEditorialText(config: MobileConfig, id: string, field: string, locale: 'en'|'ar', text: string) {
  const next=structuredClone(config),section=next.screens.home.sections.find(s=>s.id===id)!;
  const props=section.props as unknown as Record<string,string>;
  const previous=props[field],key=`${id}_${field}`;props[field]=key;
  for(const language of next.localization.supportedLocales){next.localization.messages[language] ||= {};next.localization.messages[language]![key] ||= next.localization.messages[language]![previous] || text;}
  next.localization.messages[locale]![key]=text;
  return next;
}

// Native capabilities are additive: never lower a draft's minimum runtime.
export function withSectionRuntime(config: MobileConfig): MobileConfig {
  const sections = config.screens.home.sections;
  const banners = sections.some(s => s.type === 'heroBanner' &&
    (s.props.layout !== undefined || s.props.imageFit !== undefined || s.props.additionalImageAssetIds !== undefined));
  const editorial = config.screens.home.layout !== undefined || sections.some(s =>
    ['headingKey', 'bodyKey', 'eyebrowKey', 'labelKey', 'appearance', 'limit', 'storefrontPath'].some(key => key in s.props) ||
    ('collectionId' in s.props && s.props.collectionId.startsWith('demo-feed-')));
  const deals = config.navigation.tabs.includes('deals') ||
    Object.values(config.navigation.icons || {}).includes('deals') ||
    sections.some(s => 'action' in s.props && s.props.action?.type === 'openTab' && s.props.action.tab === 'deals');
  const minimum = banners ? 3 : editorial || deals ? 2 : config.navigation.icons ? 1 : 0;
  const versions = ['1.0.0', '1.1.0', '1.2.0', '1.3.0'] as const;
  const next = structuredClone(config);
  for (const platform of ['minIosRuntime', 'minAndroidRuntime'] as const) {
    const current = versions.indexOf(next.compatibility[platform] as typeof versions[number]);
    if (current >= 0 && current < minimum) next.compatibility[platform] = versions[minimum];
  }
  return next;
}
