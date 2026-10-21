import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { InterfaceBundle } from '../../packages/api-client/src/interface-translations';
const registry=JSON.parse(readFileSync(new URL('../../apps/storefront/src/interface-messages.json',import.meta.url),'utf8'));
const theme=JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json',import.meta.url),'utf8')).default;
const customer={id:'11111111-1111-4111-8111-111111111111',email:'ada@example.test',verified:true,mobile_number:null};
for(const width of [390,1440]) {
  test(`saved admin phrases reflect throughout account and support at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});
    const errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    let bundle:InterfaceBundle={revision:1,catalog_version:'test',messages:registry.messages.map((m:object)=>({plural:null,...m})),overrides:[]};
    let outage=false;
    const contentLocales:string[]=[];
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url()),path=url.pathname;
      if(path==='/api/v1/languages/interface')return route.fulfill({status:outage?503:200,json:outage?{error:'temporarily unavailable'}:bundle});
      if(path==='/api/v1/languages')return route.fulfill({json:{source_locale:'en',languages:[{locale:'ar',name:'Arabic',native_name:'العربية',direction:'rtl',revision:1}]}});
      if(path.includes('/theme/'))return route.fulfill({json:{configuration:theme,cities:[]}});
      if(path.endsWith('/auth/refresh'))return route.fulfill({json:{customer,access_token:'fixture'}});
      if(path.endsWith('/customer/me'))return route.fulfill({json:customer});
      if(path.endsWith('/customer/profile'))return route.fulfill({json:{first_name:'Ada',last_name:'Lovelace',gender:'female',date_of_birth:null,attributes:{}}});
      if(path.includes('/content/')){contentLocales.push(url.searchParams.get('locale')||'');return route.fulfill({json:{key:'fixture',title:'',blocks:[]}});}
      if(path.endsWith('/cart'))return route.fulfill({json:{id:'cart',items:[],subtotal:'0.00',currency:'USD',fully_reserved:true,discount_amount:'0',discount_snapshot:[]}});
      return route.fulfill({json:[]});
    });
    await page.goto('/account?lang=ar');
    await expect(page.getByRole('heading',{name:'البيانات الشخصية',exact:true})).toBeVisible();
    await expect(page.getByLabel('الاسم الأول',{exact:true})).toHaveValue('Ada');
    const source=bundle.messages.find(m=>m.key==='account.personal_details')!.ar.other!;
    bundle={...bundle,revision:2,overrides:[{key:'account.personal_details',locale:'ar',form:'other',text:'ملفي الشخصي',source_text:source}]};
    // An open shopper session must reflect a newly saved admin phrase without reload.
    await expect(page.getByRole('heading',{name:'ملفي الشخصي',exact:true})).toBeVisible({timeout:10000});
    outage=true;
    await page.waitForResponse(response=>response.url().includes('/languages/interface')&&response.status()===503,{timeout:10000});
    await expect(page.getByRole('heading',{name:'ملفي الشخصي',exact:true})).toBeVisible();
    outage=false;
    for(const [path,heading] of [
      ['/account/wishlist','قائمة رغباتك'],['/account/orders','طلباتك'],
      ['/account/tickets','تذاكر الدعم الخاصة بك'],['/support','فتح تذكرة دعم'],
    ]){
      await page.goto(`${path}?lang=ar`);
      await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    }
    await expect(page.getByPlaceholder('صف المشكلة باختصار')).toBeVisible();
    await expect(page.getByRole('option',{name:'مشكلة في الطلب',exact:true})).toHaveCount(1);
    await page.goto('/account/locations?lang=ar');
    await expect(page.getByText('أضف عنوانك الأول واحفظ التفاصيل لتسهيل التوصيل.',{exact:true})).toBeVisible();
    expect(contentLocales).toContain('ar');
    const firstName=bundle.messages.find(m=>m.key==='account.first_name')!;
    const required=bundle.messages.find(m=>m.key==='validation.required')!;
    bundle={...bundle,revision:3,overrides:[...bundle.overrides,
      {key:firstName.key,locale:'en',form:'other',text:'Given name',source_text:firstName.en.other!},
      {key:required.key,locale:'en',form:'other',text:'Please complete this field.',source_text:required.en.other!},
    ]};
    await page.goto('/account?lang=en');
    await expect(page.getByLabel('Given name',{exact:true})).toHaveValue('Ada');
    await page.goto('/support?lang=en');
    await page.getByRole('button',{name:'Open ticket',exact:true}).click();
    expect(await page.getByPlaceholder('Briefly describe your issue').evaluate((input:HTMLInputElement)=>input.validationMessage)).toBe('Please complete this field.');
    expect(errors).toEqual([]);
  });
}
