import type { Locale } from './storefront';

const en = {
  home: 'Home', catalog: 'Explore', bag: 'Bag', settings: 'Settings',
  preview: 'LOCAL PREVIEW', previewNotice: 'Demo products and prices. This preview does not place orders.',
  marketTitle: 'Good things.\nEvery day.', boutiqueTitle: 'Small details.\nLasting favorites.',
  marketSubtitle: 'A little fresh inspiration for your everyday basket.',
  boutiqueSubtitle: 'Thoughtful essentials, chosen for the way you live.',
  shop: 'Explore the collection', featured: 'Picked for you', all: 'All products', search: 'Search products',
  noResults: 'No products found', trySearch: 'Try another name or clear your search.', clear: 'Clear search',
  add: 'Add to bag', added: 'In your bag', available: 'In stock', unavailable: 'Out of stock',
  close: 'Close', emptyTitle: 'Your bag is waiting', emptyText: 'Find a little something you love.',
  subtotal: 'Subtotal', remove: 'Remove', increase: 'Increase quantity', decrease: 'Decrease quantity',
  preferences: 'Make yourself at home', language: 'Language', appearance: 'Appearance',
  system: 'System', light: 'Light', dark: 'Dark', store: 'Preview store',
  storeNotice: 'Switching stores starts a new bag. Your bag and preferences last for this app session.',
  about: 'About this preview', aboutText: 'Explore the same Market and Boutique demo catalogs as our iOS and Android apps. Live accounts, checkout, payments and order tracking are coming in a later phase.',
  items: 'items',
};
const ar: Record<keyof typeof en, string> = {
  home: 'الرئيسية', catalog: 'استكشف', bag: 'الحقيبة', settings: 'الإعدادات',
  preview: 'معاينة محلية', previewNotice: 'منتجات وأسعار تجريبية. لا يمكن إتمام الطلبات في هذه المعاينة.',
  marketTitle: 'اختيارات جميلة.\nلكل يوم.', boutiqueTitle: 'تفاصيل صغيرة.\nلمسة تدوم.',
  marketSubtitle: 'إلهام طازج لسلة مشترياتك اليومية.', boutiqueSubtitle: 'أساسيات مختارة بعناية لتناسب حياتك.',
  shop: 'استكشف المجموعة', featured: 'اخترنا لك', all: 'كل المنتجات', search: 'ابحث عن المنتجات',
  noResults: 'لا توجد منتجات', trySearch: 'جرّب اسماً آخر أو امسح البحث.', clear: 'مسح البحث',
  add: 'أضف إلى الحقيبة', added: 'في حقيبتك', available: 'متوفر', unavailable: 'غير متوفر',
  close: 'إغلاق', emptyTitle: 'حقيبتك بانتظارك', emptyText: 'اكتشف شيئاً تحبه.',
  subtotal: 'المجموع الفرعي', remove: 'إزالة', increase: 'زيادة الكمية', decrease: 'تقليل الكمية',
  preferences: 'تجربة على ذوقك', language: 'اللغة', appearance: 'المظهر',
  system: 'النظام', light: 'فاتح', dark: 'داكن', store: 'متجر المعاينة',
  storeNotice: 'تغيير المتجر يبدأ حقيبة جديدة. تُحفظ الحقيبة والتفضيلات خلال جلسة التطبيق فقط.',
  about: 'عن هذه المعاينة', aboutText: 'استكشف نفس كتالوجات السوق والبوتيك التجريبية في تطبيقاتنا على آيفون وأندرويد. الحسابات المباشرة وإتمام الشراء والدفع وتتبع الطلبات ستتوفر في مرحلة لاحقة.',
  items: 'منتجات',
};
export const strings = (locale: Locale) => locale === 'ar' ? ar : en;
