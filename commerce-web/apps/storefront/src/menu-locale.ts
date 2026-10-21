import { useInterface } from './interface-locale';

export type MenuLocale = string;
export function menuLocale(value: string | null, available: readonly string[] = ['en', 'ar']): MenuLocale | undefined {
  return value && available.includes(value) ? value : undefined;
}
export function localizedMenuUrl(url: string, locale: MenuLocale): string {
  if (!url.startsWith('/') || url.startsWith('//')) return url;
  // Preserve the path verbatim: URL normalization could turn /a/..//host
  // into a protocol-relative destination after it passed the URL safety check.
  const hashIndex = url.indexOf('#');
  const hash = hashIndex < 0 ? '' : url.slice(hashIndex);
  const pathAndQuery = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const queryIndex = pathAndQuery.indexOf('?');
  const path = queryIndex < 0 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? '' : pathAndQuery.slice(queryIndex + 1));
  query.set('lang', locale);
  return `${path}?${query}${hash}`;
}
export function useMenuLocale(available?: readonly string[], source = 'en') {
  const ui = useInterface();
  return { locale: ui.preview ? ui.locale : available ? menuLocale(ui.locale, available) ?? source : ui.locale };
}
