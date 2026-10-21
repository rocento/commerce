

export const SHOPPER_LOCALE_KEY = 'commerce-interface-locale';
export function shopperLocale(value: string | null, available: readonly string[] = ['en', 'ar']): string {
  return value && available.includes(value) ? value : available[0] || 'en';
}
export function readShopperLocale(available: readonly string[] = ['en', 'ar']): string {
  try { return shopperLocale(localStorage.getItem(SHOPPER_LOCALE_KEY), available); }
  catch { return 'en'; }
}
export function saveShopperLocale(locale: string): void {
  try { localStorage.setItem(SHOPPER_LOCALE_KEY, locale); }
  catch { /* The current session can still switch when storage is unavailable. */ }
}
