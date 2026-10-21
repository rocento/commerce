import type { MarketDraft } from '@commerce/api-client';

export function languageMarkets(locale: string, markets: readonly MarketDraft[]) {
  return markets.filter(market => market.locales.includes(locale)).map(market => ({
    id: market.id, name: market.name, isDefault: market.default_locale === locale,
  }));
}

export function matchesLanguage(language: { locale: string; name: string; native_name: string }, search: string, marketId: string, markets: readonly MarketDraft[]) {
  const term = search.trim().toLocaleLowerCase();
  return [language.locale, language.name, language.native_name].some(value => value.toLocaleLowerCase().includes(term))
    && (!marketId || markets.some(market => market.id === marketId && market.locales.includes(language.locale)));
}
