import { describe, expect, it } from 'vitest';
import type { MarketDraft } from '@commerce/api-client';
import { languageMarkets, matchesLanguage } from './language-market-model';
const markets: MarketDraft[] = [
  {id:'eg',name:'Egypt',country:'EG',currency:'EGP',locales:['en','ar'],default_locale:'ar',revision:2},
  {id:'us',name:'United States',country:'US',currency:'USD',locales:['en'],default_locale:'en',revision:1},
];
describe('shared languages and market assignments', () => {
  it('reports only assigned markets and their own default languages', () => {
    expect(languageMarkets('ar',markets)).toEqual([{id:'eg',name:'Egypt',isDefault:true}]);
    expect(languageMarkets('en',markets).map(market=>market.isDefault)).toEqual([false,true]);
    expect(languageMarkets('fr',markets)).toEqual([]);
  });
  it('combines market filters with locale, native and display name search', () => {
    const ar = {locale:'ar',name:'Arabic',native_name:'العربية'};
    expect(matchesLanguage(ar,' العربية ','eg',markets)).toBe(true);
    expect(matchesLanguage(ar,'ARABIC','us',markets)).toBe(false);
    expect(matchesLanguage(ar,'ar','',markets)).toBe(true);
    expect(matchesLanguage(ar,'French','eg',markets)).toBe(false);
  });
});
