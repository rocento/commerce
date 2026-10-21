import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { defaultTheme } from '@commerce/api-client';
import { PublicPage } from './page';
import type { PublicSnapshot } from './types';
it('renders published component translations on public pages without changing the snapshot',()=>{
  const theme = defaultTheme();
  const hero = theme.pages.home[0];
  hero.translations = {ar:{heading:{source:String(hero.settings.heading),value:'طعام جيد كل يوم'}}};
  const snapshot = {theme,locale:'ar',categories:[],category_id:null,product:null,kind:'home',images:{},collections:{},products:[],page:1,has_next:false,path:'/',status:200,site_name:'Store',content:null,guides:[],merchant:null} as unknown as PublicSnapshot;
  const html=renderToStaticMarkup(<PublicPage snapshot={snapshot}/>);
  expect(html).toContain('طعام جيد كل يوم');
  expect(hero.settings.heading).toBe('Good food. Everyday.');
  const english=renderToStaticMarkup(<PublicPage snapshot={{...snapshot,locale:'en'}}/>);
  expect(english).toContain('Good food. Everyday.');
  expect(english).not.toContain('طعام جيد كل يوم');
});

it('reflects admin Arabic footer edits in published pages with safe source fallback', async () => {
  const { themeContract, validateTheme, themeTranslationIssues } = await import('@commerce/api-client');
  const { updateThemeTranslation } = await import('../../../admin/src/theme-text');
  const theme = defaultTheme();
  let footer = {id:'footer-options',component:'footer_options',version:1,enabled:true,settings:Object.fromEntries(Object.entries(themeContract.components.footer_options.settings).map(([key,p])=>[key,p.default]))};
  const labels: Record<string,string> = {service_1:'مختارة بعناية',service_2:'نحن هنا لمساعدتك',service_3:'تسوق بثقة',column_1_heading:'خدمة العملاء',column_1_link_1_label:'تواصل معنا',column_1_link_2_label:'معلومات التوصيل',column_2_heading:'حسابك',column_2_link_1_label:'حسابي',column_2_link_2_label:'طلباتي',column_3_heading:'اكتشف',column_3_link_1_label:'تسوق المنتجات',column_3_link_2_label:'مساعد التسوق',newsletter_title:'ابق على اطلاع',newsletter_text:'اكتشف أحدث الأخبار',newsletter_label:'اكتشف الجديد',copyright:'جميع الحقوق محفوظة',back_to_top_label:'العودة إلى الأعلى'};
  for (const [key,value] of Object.entries(labels)) footer = updateThemeTranslation(footer,'ar',key,{source:String(footer.settings[key]),value});
  footer.settings.show_newsletter = 'on';
  theme.global.bottom.push(footer);
  const snapshot = {theme,locale:'ar',categories:[],category_id:null,product:null,kind:'home',images:{},collections:{},products:[],page:1,has_next:false,path:'/',status:200,site_name:'Store',content:null,guides:[],merchant:null} as unknown as PublicSnapshot;
  expect(validateTheme(theme)).toEqual([]);
  expect(themeTranslationIssues(theme)).toEqual([]);
  const html = renderToStaticMarkup(<PublicPage snapshot={snapshot}/>);
  for (const label of Object.values(labels)) expect(html).toContain(label);
  expect(html).toContain('href="/support"');
  expect(html).not.toContain('Back to top');
  expect(html).toContain('lang="ar" dir="rtl"');
  expect(footer.settings.copyright).toBe('All rights reserved.');
  const english = renderToStaticMarkup(<PublicPage snapshot={{...snapshot,locale:'en'}}/>);
  expect(english).toContain('Back to top');
  expect(english).not.toContain('جميع الحقوق محفوظة');
  footer.settings.copyright = 'Updated legal text';
  expect(themeTranslationIssues(theme)).toHaveLength(1);
  expect(renderToStaticMarkup(<PublicPage snapshot={snapshot}/>)).toContain('Updated legal text');
});

it('renders saved admin interface phrases in published documents before hydration',()=>{
  const snapshot = {theme:defaultTheme(),locale:'ar',categories:[],category_id:null,product:null,kind:'home',images:{},collections:{},products:[],page:1,has_next:false,path:'/',status:200,site_name:'Store',content:null,guides:[],merchant:null,
    interface_bundle:{revision:2,catalog_version:'test',messages:[{key:'navigation.account',group:'navigation',plural:null,en:{other:'My account'},ar:{other:'حسابي'}}],overrides:[{key:'navigation.account',locale:'ar',form:'other',text:'مساحة حسابي',source_text:'حسابي'}]}
  } as unknown as PublicSnapshot;
  const translated=renderToStaticMarkup(<PublicPage snapshot={snapshot}/>);
  expect(translated).toContain('مساحة حسابي');
  expect(translated).toContain('تصفح منتجاتنا');
  expect(translated).toContain('dir="rtl" id="store-top"');
  const invalid={...snapshot,interface_bundle:{invalid:true}};
  const fallback=renderToStaticMarkup(<PublicPage snapshot={invalid}/>);
  expect(fallback).toContain('حسابي');
  expect(fallback).not.toContain('مساحة حسابي');
});
