import { test, expect, type Page } from '@playwright/test';
const id='20000000-0000-0000-0000-000000000002';
const item=(label:string)=>({kind:'link',heading:'',text:'',image_id:null,link_label:label,link_url:'/search',navigation:{icon:'',badge:'',enabled:true,new_tab:false,columns:2,links:label==='Shop'?[{label:'Fruit',url:'/categories/fruit',group:'Fresh',description:'Seasonal produce',icon:'',new_tab:false}]:[]}});
async function setup(page:Page,write=true){
 const document={id,kind:'navigation',key:'navigation',version:1};
 const revision={id,document_id:id,version:1,title:'Main menu',blocks:[item('Shop'),item('About')]};
 const saves:unknown[]=[];
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  let body:unknown=[];
  if(path.endsWith('/admin/me'))body={user:{id,name:'Admin',email:'admin@example.com'},permissions:write?['*']:['cms.read']};
  else if(path.endsWith('/admin/markets'))body={items:[],live:{region:'EG',currency:'EGP'},locales:['en'],activation_available:false};
  else if(path.endsWith('/admin/languages'))body={source_locale:'en',publication_available:false,languages:[]};
  else if(path.endsWith('/admin/content')&&route.request().method()==='POST'){saves.push(route.request().postDataJSON());body={document_id:id,revision_id:id,version:2};}
  else if(path.endsWith('/admin/content'))body=[document];
  else if(path.endsWith(`/admin/content/${id}`))body={document,revisions:[revision],releases:[]};
  else if(path.endsWith('/sorts'))body=['id'];
  else if(path.includes('/grids/'))body={items:[],total_count:0,next_cursor:null};
  else if(path.endsWith('/categories'))body=[{id,name:'Fruit',slug:'fruit',parent_id:null}];
  else if(path.includes('/content/navigation'))body=null;
  await route.fulfill({json:body});
 });
 await page.goto('/content/navigation');
 await expect(page.getByRole('heading',{name:'Navigation',exact:true})).toBeVisible();
 return saves;
}
test('menu editing preserves other items, follows reordering, and confirms deletion',async({page})=>{
 const saves=await setup(page);const editor=page.locator('.menu-item-detail');
 await editor.getByLabel('Label',{exact:true}).fill('Shop groceries');
 await page.locator('.menu-outline').getByRole('button',{name:/About/}).click();
 await expect(editor.getByLabel('Label',{exact:true})).toHaveValue('About');
 await editor.getByRole('button',{name:'Move up',exact:true}).click();
 await expect(page.locator('.menu-outline-item').first()).toContainText('About');
 await expect(editor.getByLabel('Label',{exact:true})).toHaveValue('About');
 await editor.getByRole('button',{name:'Remove item',exact:true}).click();
 await editor.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.locator('.menu-outline-item')).toHaveCount(2);
 await editor.getByRole('button',{name:'Duplicate',exact:true}).click();
 await expect(page.locator('.menu-outline-item')).toHaveCount(3);
 await editor.getByRole('button',{name:'Remove item',exact:true}).click();
 await editor.getByRole('button',{name:'Confirm removal',exact:true}).click();
 await expect(page.locator('.menu-outline-item')).toHaveCount(2);
 await page.getByRole('button',{name:'Save draft',exact:true}).click();
 await expect.poll(()=>saves.length).toBe(1);
 await page.screenshot({path:'test-results/megamenu-desktop.png',fullPage:true});
 expect((saves[0] as {blocks:{link_label:string}[]}).blocks.map(b=>b.link_label)).toEqual(['About','Shop groceries']);
});
test('preview responds to selection and visibility; mobile layout fits',async({page})=>{
 await page.setViewportSize({width:390,height:844});await setup(page);
 const preview=page.locator('.menu-preview');
 await expect(preview.getByText('Seasonal produce')).toBeVisible();
 await preview.getByRole('button',{name:'About',exact:true}).click();
 await expect(preview.getByText('This item takes customers directly to its destination.')).toBeVisible();
 await expect(preview.getByText('Seasonal produce')).toHaveCount(0);
 await page.locator('.menu-outline').getByRole('button',{name:/About/}).click();
 await page.locator('.menu-item-detail').getByLabel('Visible',{exact:true}).uncheck();
 await expect(preview.getByRole('button',{name:'About',exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/megamenu-mobile.png',fullPage:true});
});
test('read-only users can inspect preview without editing controls',async({page})=>{
 await setup(page,false);
 await expect(page.locator('.menu-preview')).toBeVisible();
 await expect(page.getByRole('button',{name:'Save draft',exact:true})).toHaveCount(0);
 await expect(page.locator('.menu-outline')).toHaveCount(0);
});
