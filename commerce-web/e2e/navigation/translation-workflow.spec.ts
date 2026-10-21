import {test,expect,type BrowserContext,type Page} from '@playwright/test';
import type { components } from '../../packages/api-client/src/schema';
const id='11111111-1111-4111-8111-111111111111';
const blocks=[{kind:'link',heading:'',text:'',image_id:null,link_label:'Shop',link_url:'/search',navigation:{icon:'',badge:'',enabled:true,new_tab:false,columns:2,links:[{label:'Fruit',url:'/categories/fruit',group:'Fresh',icon:'',description:'Daily picks',new_tab:false}]}},{kind:'link',heading:'',text:'',image_id:null,link_label:'Contact',link_url:'/pages/contact',navigation:{icon:'',badge:'',enabled:true,new_tab:false,columns:1,links:[]}}];
const source={title:'Storefront navigation',__version:'1','item.0.label':'Shop','item.0.badge':'','item.0.link.0.label':'Fruit','item.0.link.0.group':'Fresh','item.0.link.0.description':'Daily picks','item.1.label':'Contact','item.1.badge':''};
async function setup(context:BrowserContext,permissions=['*']){
 let version=1,revision=1,fields:Record<string,string>={title:'قائمة المتجر','item.0.label':'تسوق','item.0.link.0.label':'الفاكهة','item.0.link.0.group':'طازج','item.0.link.0.description':'اختيارات يومية','item.1.label':'اتصل بنا'},reviewed=true,failSave=false,failPublish=false;
 let published: (components['schemas']['ContentPublish'] & {fields:Record<string,string>}) | null = null;
 await context.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method();let body:unknown=[];
  const document={id,key:'navigation',kind:'navigation',version,updated_at:new Date().toISOString()},contentRevision={id,document_id:id,version,title:source.title,blocks,created_at:new Date().toISOString()};
  if(path.endsWith('/admin/me'))body={user:{id,name:'Editor',email:'editor@example.test'},permissions};
  else if(path.endsWith('/admin/languages'))body={source_locale:'en',languages:[{locale:'ar',name:'Arabic',native_name:'العربية',direction:'rtl',revision:1}]};
  else if(path.includes('/languages/ar/translations/navigation/')){
   if(method==='PUT'){
    if(failSave)return route.fulfill({status:500,json:{error:'Save failed'}});
    const input=route.request().postDataJSON();expect(input.expected_revision).toBe(revision);expect(input.source.__version).toBe(String(version));fields=input.fields;reviewed=input.reviewed;revision++;body={revision,status:reviewed?'reviewed':'draft'};
   }else body={entity_id:id,name:source.title,source:{...source,__version:String(version)},fields,revision,status:reviewed?'reviewed':'draft'};
  }
  else if(path.endsWith('/admin/markets'))body={items:[],live:{region:'EG',currency:'EGP'},locales:['en'],activation_available:false};
  else if(path.endsWith('/admin/content'))body=[document];
  else if(path.endsWith(`/admin/content/${id}`))body={document,revisions:[contentRevision],releases:[]};
  else if(path.endsWith(`/admin/content/${id}/releases`)){
   if(failPublish)return route.fulfill({status:500,json:{error:'Publish failed'}});
   const input:components['schemas']['ContentPublish']=route.request().postDataJSON();expect(input.revision_id).toBe(id);published={...input,fields:structuredClone(fields)};body={status:'ok'};
  }
  else if(path.endsWith('/content/navigation'))body=published?{key:'navigation',title:source.title,version,blocks}:null;
  else if(path.includes('/grids/'))body={items:[],total_count:0,next_cursor:null};
  await route.fulfill({json:body});
 });
 return{published:()=>published,sourceChanged:()=>{version++},failSave:(value:boolean)=>{failSave=value},failPublish:(value:boolean)=>{failPublish=value}};
}
async function openArabic(page:Page){await page.goto('/content/navigation');await page.getByLabel('Content language').selectOption('ar');await expect(page.getByRole('heading',{name:'Arabic content',exact:true})).toBeVisible();}
test('aligned scope controls and Arabic workspace at desktop and mobile sizes',async({page,context},info)=>{
 await setup(context);await page.goto('/content/navigation');await expect(page.getByText('Languages & translations',{exact:true})).toHaveCount(0);await expect(page.getByText(/Arabic is available/)).toHaveCount(0);
 const market=await page.getByLabel('Market',{exact:true}).boundingBox(),language=await page.getByLabel('Content language').boundingBox();expect(Math.abs(market!.y-language!.y)).toBeLessThanOrEqual(2);
 await page.getByLabel('Content language').selectOption('ar');await expect(page.getByRole('complementary',{name:'Menu structure'})).toBeVisible();await expect(page.getByLabel('Label · Arabic',{exact:true})).toHaveValue('تسوق');await expect(page.getByLabel('Label · Arabic',{exact:true})).toHaveAttribute('dir','rtl');await expect(page.getByLabel('Link label · Arabic',{exact:true})).toHaveValue('الفاكهة');
 await page.getByRole('button',{name:/2 اتصل بنا/}).click();await expect(page.getByLabel('Label · Arabic',{exact:true})).toHaveValue('اتصل بنا');await page.screenshot({path:info.outputPath('arabic-menu-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('arabic-menu-mobile.png'),fullPage:true});
});
test('draft saves privately, survives reload and publishes after review',async({page,context})=>{
 const state=await setup(context);await openArabic(page);await page.getByLabel('Label · Arabic',{exact:true}).fill('تسوق الآن');await expect(page.getByRole('button',{name:'Publish menu',exact:true})).toBeDisabled();await page.getByRole('button',{name:'Save translation draft',exact:true}).click();await expect(page.getByText('Arabic translation saved as a draft.',{exact:true})).toBeVisible();expect(state.published()).toBeNull();await page.getByRole('button',{name:'Reload saved translation',exact:true}).click();await expect(page.getByLabel('Label · Arabic',{exact:true})).toHaveValue('تسوق الآن');await page.getByLabel('I reviewed this translation against the current source').check();await page.getByRole('button',{name:'Save reviewed translation',exact:true}).click();await expect(page.getByRole('button',{name:'Publish menu',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Publish menu',exact:true}).click();await expect(page.getByText('Menu published with its reviewed translations.',{exact:true})).toBeVisible();expect(state.published()?.fields['item.0.label']).toBe('تسوق الآن');
});
test('failed saves retain edits and release failures can be retried and scheduled',async({page,context})=>{
 const state=await setup(context);await openArabic(page);state.failSave(true);await page.getByLabel('Label · Arabic',{exact:true}).fill('تسوق الآن');await page.getByRole('button',{name:'Save translation draft',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Save failed');await expect(page.getByLabel('Label · Arabic',{exact:true})).toHaveValue('تسوق الآن');state.failSave(false);await page.getByLabel('I reviewed this translation against the current source').check();await page.getByRole('button',{name:'Save reviewed translation',exact:true}).click();state.failPublish(true);await page.getByRole('button',{name:'Publish menu',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Publish failed');state.failPublish(false);await page.getByLabel('Start (local time; blank = now)').fill('2030-01-01T12:00');await page.getByRole('button',{name:'Schedule menu',exact:true}).click();await expect(page.getByText('Menu release scheduled. The current storefront menu stays live until then.',{exact:true})).toBeVisible();expect(state.published()?.starts_at).toBeTruthy();
});
test('source changes block release',async({page,context})=>{
 const state=await setup(context);await openArabic(page);state.sourceChanged();await page.getByRole('button',{name:'Publish menu',exact:true}).click();await expect(page.getByRole('alert')).toContainText('The source menu changed');expect(state.published()).toBeNull();
});
test('editors without publishing permission cannot release',async({page,context})=>{
 await setup(context,['cms.read','cms.write','languages.read','languages.write']);await openArabic(page);await expect(page.getByRole('button',{name:'Publish menu',exact:true})).toHaveCount(0);
});

test('publication locks language switching and translation editing until completion',async({page,context})=>{
 await setup(context);await openArabic(page);
 let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve});
 await page.route('**/api/v1/admin/content/*/releases',async route=>{await gate;await route.fallback()});
 await page.getByRole('button',{name:'Publish menu',exact:true}).click();
 await expect(page.getByLabel('Content language')).toBeDisabled();
 await expect(page.getByLabel('Label · Arabic',{exact:true})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Reload saved translation',exact:true})).toBeDisabled();
 finish();await expect(page.getByText('Menu published with its reviewed translations.',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Content language')).toBeEnabled();
});
