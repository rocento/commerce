import { describe, expect, it } from 'vitest';
import { defaultTheme, localizeTheme, themeTranslationIssues, themeContract, validThemeLocale, validateTheme } from './themes';

function translatedTheme() {
  const config = defaultTheme();
  const hero = config.pages.home.find(section => section.component === 'hero')!;
  hero.translations = {ar:{heading:{source:String(hero.settings.heading),value:'اختيارات طازجة'}}};
  return {config, hero};
}
describe('theme component translations', () => {
  it('preserves source configuration while resolving an exact locale and falling back for missing fields', () => {
    const {config,hero} = translatedTheme();
    expect(validateTheme(config)).toEqual([]);
    const localized = localizeTheme(config,'ar').pages.home.find(section=>section.id===hero.id)!;
    expect(localized.settings.heading).toBe('اختيارات طازجة');
    expect(localized.settings.text).toBe(hero.settings.text);
    expect(localizeTheme(config,'ar-EG').pages.home.find(section=>section.id===hero.id)?.settings.heading).toBe(hero.settings.heading);
    expect(hero.settings.heading).not.toBe('اختيارات طازجة');
  });
  it('does not display stale translations and reports them for the publication gate', () => {
    const {config,hero} = translatedTheme();
    hero.settings.heading = 'Changed source';
    expect(validateTheme(config)).toEqual([]); // drafts may be saved for review
    expect(themeTranslationIssues(config)).toHaveLength(1);
    expect(localizeTheme(config,'ar').pages.home.find(section=>section.id===hero.id)?.settings.heading).toBe('Changed source');
  });
  it('rejects overrides for behavior, URLs, assets, product queries and arbitrary fields', () => {
    for (const key of ['href','image','query','enabled','__proto__']) {
      const {config,hero} = translatedTheme();
      hero.translations = {ar:{[key]:{source:'',value:'unsafe'}}};
      expect(validateTheme(config).length).toBeGreaterThan(0);
    }
  });
  it('rejects invalid text, malformed payloads and locale aliases', () => {
    for (const field of [null,{},'text',{source:7,value:'Arabic'},{source:'Text',value:'<script>'},{source:'Text',value:' '},{source:'Text',value:'أ'.repeat(300)},{source:'Text',value:'Arabic',extra:true}]) {
      const {config,hero} = translatedTheme();
      hero.translations = {ar:{heading:field}} as never;
      expect(()=>validateTheme(config)).not.toThrow();
      expect(validateTheme(config).length).toBeGreaterThan(0);
    }
    for (const locale of ['ar-eg','EN','../ar','ar-EG-extra']) {
      const {config,hero} = translatedTheme();
      hero.translations = {[locale]:hero.translations!.ar};
      expect(validateTheme(config).length).toBeGreaterThan(0);
    }
    for (const locale of ['ar','en-GB','zh-Hant','zh-Hant-TW','es-419']) expect(validThemeLocale(locale)).toBe(true);
  });
  it('translates global footer text and preserves publication snapshots independently from later edits', () => {
    const {config} = translatedTheme();
    const footer = {id:'translated-footer',component:'footer_options',version:1,enabled:true,settings:Object.fromEntries(Object.entries(themeContract.components.footer_options.settings).map(([key,property])=>[key,property.default])),translations:{ar:{copyright:{source:String(themeContract.components.footer_options.settings.copyright.default),value:'جميع الحقوق محفوظة'}}}};
    config.global.bottom.push(footer);
    expect(validateTheme(config)).toEqual([]);
    expect(localizeTheme(config,'ar').global.bottom.at(-1)?.settings.copyright).toBe('جميع الحقوق محفوظة');
    const published = structuredClone(config);
    config.pages.home[0].translations!.ar.heading.value = 'Updated draft';
    expect(localizeTheme(published,'ar').pages.home[0].settings.heading).toBe('اختيارات طازجة');

  });
});

it('keeps older footer settings valid and translates newly inherited text', () => {
  const config = defaultTheme();
  const settings = Object.fromEntries(Object.entries(themeContract.components.footer_options.settings).filter(([key])=>key !== 'back_to_top_label' && !key.startsWith('install_')).map(([key,p])=>[key,p.default]));
  config.global.bottom.push({id:'legacy-footer-options',component:'footer_options',version:1,enabled:true,settings,translations:{ar:{back_to_top_label:{source:'Back to top',value:'العودة إلى الأعلى'}}}});
  expect(validateTheme(config)).toEqual([]);
  expect(themeTranslationIssues(config)).toEqual([]);
  expect(localizeTheme(config,'ar').global.bottom.at(-1)?.settings.back_to_top_label).toBe('العودة إلى الأعلى');
  expect(settings).not.toHaveProperty('back_to_top_label');
});
