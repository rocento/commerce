import type { Locale } from './commerce';

const formatters = new Map<string, Intl.NumberFormat>();
/** Reuse expensive locale formatters across product rows, with a bounded key set. */
export function formatMoney(value: string, currency: string, locale: Locale) {
  const key = `${locale}|${currency}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', { style: 'currency', currency });
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!);
    formatters.set(key, formatter);
  }
  return formatter.format(Number(value));
}
