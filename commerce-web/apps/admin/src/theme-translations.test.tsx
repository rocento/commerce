import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { defaultTheme } from '@commerce/api-client';
import { ThemeTranslations } from './theme-translations';

function render(options: {stale?:boolean;disabled?:boolean;locale?:string} = {}) {
  const client = new QueryClient({defaultOptions:{queries:{staleTime:Infinity,gcTime:Infinity}}});
  client.setQueryData(['public-languages'],{source_locale:'en',languages:[{locale:'en',native_name:'English',direction:'ltr'},{locale:'ar',native_name:'العربية',direction:'rtl'},{locale:'fr',native_name:'Français',direction:'ltr'}]});
  const configuration = defaultTheme();
  const hero = configuration.pages.home[0];
  hero.translations = {ar:{heading:{source:options.stale ? 'Old source' : String(hero.settings.heading),value:'طعام جيد'}}};
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><ThemeTranslations configuration={configuration} disabled={!!options.disabled} locale={options.locale ?? 'ar'} languages={client.getQueryData(['public-languages'])} onChange={()=>{}}/></QueryClientProvider>);
  client.clear();
  return html;
}
it('inherits the theme language, with translation coverage and RTL fields',()=>{
  const html = render();
  expect(html).not.toContain('Translation language<select');
  expect(html).not.toContain('Français');
  expect(html).toContain('1 / 12 translated');
  expect(html).toContain('lang="ar" dir="rtl"');
  expect(html).toContain('طعام جيد');
  expect(html).toContain('Add inherited text to the draft for translation');
});
it('shows changed source and explicit review controls',()=>{
  const html = render({stale:true});
  expect(html).toContain('1 need review');
  expect(html).toContain('Previously translated source: Old source');
  expect(html).toContain('Confirm translation matches source');
});
it('disables editing for readers and isolates language values',()=>{
  const readonly = render({disabled:true});
  expect(readonly).toContain('dir="rtl" disabled=""');
  const french = render({locale:'fr'});
  expect(french).toContain('lang="fr" dir="ltr"');
  expect(french).not.toContain('طعام جيد');
});

it('exposes all inherited footer text including install instructions for Arabic review', async () => {
  const { themeContract } = await import('@commerce/api-client');
  const configuration = defaultTheme();
  configuration.global.bottom.push({id:'legacy-footer',component:'footer_options',version:1,enabled:true,settings:Object.fromEntries(Object.entries(themeContract.components.footer_options.settings).filter(([key])=>key !== 'back_to_top_label' && !key.startsWith('install_')).map(([key,p])=>[key,p.default]))});
  const html = renderToStaticMarkup(<ThemeTranslations configuration={configuration} disabled={false} locale="ar" languages={{source_locale:'en',languages:[{locale:'ar',native_name:'العربية',direction:'rtl'}]} as never} onChange={()=>{}}/>);
  expect(html).toContain('Back to top');
  expect(html).toContain('Install app');
  expect(html).toContain('An internet connection is required to shop.');
  expect(html).toContain('lang="ar" dir="rtl"');
  expect(configuration.global.bottom.at(-1)?.settings).not.toHaveProperty('back_to_top_label');
});
