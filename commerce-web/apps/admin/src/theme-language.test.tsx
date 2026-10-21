import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { defaultTheme, localizeTheme, themeContract, type PublicLanguages, type AdminIdentity } from '@commerce/api-client';
import { ThemeEditor } from './themes';
import { ThemeLanguage } from './theme-language';
import { ThemeSectionSettings } from './theme-section-settings';
import { updateThemeTranslation } from './theme-text';

const languages: PublicLanguages = {source_locale:'en',languages:[
  {locale:'en',name:'English',native_name:'English',direction:'ltr',revision:1},
  {locale:'ar',name:'Arabic',native_name:'العربية',direction:'rtl',revision:1},
  {locale:'fr',name:'French',native_name:'Français',direction:'ltr',revision:1},
]};
const who: AdminIdentity = {permissions:['theme.read'],user:{id:'user',email:'reader@example.test',name:'Reader',role_id:'reader',active:true,created_at:'2026-10-02T00:00:00Z'}};
it('places exactly one language switcher above the theme tabs',()=>{
  const client = new QueryClient({defaultOptions:{queries:{staleTime:Infinity,gcTime:Infinity}}});
  client.setQueryData(['public-languages'],languages);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><ThemeEditor theme={{id:'theme',name:'Test theme',owner_channel:'storefront',revision:1,configuration:defaultTheme(),published_version:null,updated_at:'2026-10-02T00:00:00Z'}} who={who} channels={[]} onClose={()=>{}}/></QueryClientProvider>);
  expect(html.match(/<select aria-label="Theme language"/g)).toHaveLength(1);
  expect(html.indexOf('class="theme-language-scope"')).toBeLessThan(html.indexOf('class="theme-tabs"'));
  expect(html).toContain('Français (fr)');
  expect(html).not.toContain('Preview language');
  client.clear();
});
it('uses the theme language for component fields without adding a component switcher',()=>{
  const section = defaultTheme().pages.home[0];
  section.translations = {ar:{heading:{source:String(section.settings.heading),value:'اختيارات طازجة'}}};
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><ThemeSectionSettings section={section} disabled resources={{media:[],mediaLoading:false,retryMedia:()=>{},canReadCatalog:false}} language={languages.languages[1]} onChange={()=>{}} onTranslationChange={()=>{}}/></QueryClientProvider>);
  client.clear();
  expect(html).toContain('lang="ar" dir="rtl"');
  expect(html).toContain('اختيارات طازجة');
  expect(html).toContain('Source:');
  expect(html).toContain('disabled=""');
  expect(html).not.toContain('Theme language');
  expect(html).not.toContain('Français');
});
it('updates multiple components in one locale and preserves source and other locales',()=>{
  const config = defaultTheme();
  const original = structuredClone(config);
  for (const section of config.pages.home) {
    if (!themeContract.components[section.component].settings.heading) continue;
    section.translations = {fr:{heading:{source:String(section.settings.heading),value:'Français'}}};
  }
  config.pages.home = config.pages.home.map(section => themeContract.components[section.component].settings.heading ? updateThemeTranslation(section,'ar','heading',{source:String(section.settings.heading),value:'عنوان عربي'}) : section);
  const arabic = localizeTheme(config,'ar');
  for (const [index,section] of config.pages.home.entries()) {
    expect(section.settings).toEqual(original.pages.home[index].settings);
    if (themeContract.components[section.component].settings.heading) {
      expect(arabic.pages.home[index].settings.heading).toBe('عنوان عربي');
      expect(section.translations?.fr.heading.value).toBe('Français');
    }
  }
  const section = config.pages.home[0];
  const cleared = updateThemeTranslation(section,'ar','heading');
  expect(cleared.translations?.ar).toBeUndefined();
  expect(cleared.translations?.fr.heading.value).toBe('Français');
  expect(section.translations?.ar.heading.value).toBe('عنوان عربي');
});
it('language metadata failure retains source editing and offers retry',()=>{
  const html = renderToStaticMarkup(<ThemeLanguage locale="" loading={false} error="Language service unavailable" onRetry={()=>{}} onChange={()=>{}}/>);
  expect(html).toContain('disabled=""');
  expect(html).toContain('Language service unavailable');
  expect(html).toContain('Retry languages');
});
