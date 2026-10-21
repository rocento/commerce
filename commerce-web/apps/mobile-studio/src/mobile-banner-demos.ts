import type { MobileConfig } from '@commerce/api-client';

export const groceryBannerArtwork = [
  { key: 'produce', name: 'Grocery demo · fresh produce', url: '/demo-banners/produce.png' },
  { key: 'pantry', name: 'Grocery demo · pantry favourites', url: '/demo-banners/pantry.png' },
  { key: 'greens', name: 'Grocery demo · market vegetables', url: '/demo-banners/greens.png' },
  { key: 'breakfast', name: 'Grocery demo · breakfast favourites', url: '/demo-banners/breakfast.png' },
] as const;

export function appendGroceryBanners(config: MobileConfig, images: Record<string, string>): MobileConfig {
  if (config.screens.home.sections.length > 28) throw new Error('Make room for two banner sections first.');
  const next = structuredClone(config);
  next.compatibility = { minIosRuntime: '1.3.0', minAndroidRuntime: '1.3.0' };
  const existing = new Set(next.screens.home.sections.map(s => s.id));
  for (const layout of ['portrait', 'horizontal'] as const) {
    let id = `grocery_${layout}`, suffix = 1;
    while (existing.has(id)) id = `grocery_${layout}_${suffix++}`;
    existing.add(id);
    const portrait = layout === 'portrait';
    const translations = portrait
      ? { en: ['Fresh fruit and vegetables', 'Fresh picks. Every day.', 'Bring home a little more colour.', 'Shop fresh'], ar: ['فواكه وخضروات طازجة', 'طازج كل يوم.', 'أضف ألوان الطبيعة إلى سلتك.', 'تسوّق الطازج'] }
      : { en: ['Bread, eggs, milk and honey', 'A better start to your day.', 'Breakfast favourites, all in one basket.', 'Shop breakfast'], ar: ['خبز وبيض وحليب وعسل', 'بداية ألذ ليومك.', 'كل مفضلات الفطور في سلة واحدة.', 'تسوّق الفطور'] };
    for (const locale of ['en', 'ar'] as const) {
      next.localization.messages[locale] ||= {};
      ['alt', 'heading', 'body', 'label'].forEach((key, i) => { next.localization.messages[locale]![`${id}_${key}`] = translations[locale][i]!; });
    }
    next.screens.home.sections.push({ id, type: 'heroBanner', props: {
      layout, imageFit: 'cover', appearance: 'campaign', imageAssetId: images[portrait ? 'produce' : 'breakfast'],
      ...(portrait ? { additionalImageAssetIds: [images.pantry, images.greens] } : {}),
      accessibilityLabelKey: `${id}_alt`, headingKey: `${id}_heading`, bodyKey: `${id}_body`, labelKey: `${id}_label`,
      action: { type: 'openTab', tab: next.navigation.tabs.includes('categories') ? 'categories' : 'home' },
    } });
  }
  return next;
}
