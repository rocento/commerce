const {chromium}=require('../../../commerce-web/node_modules/@playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const products=JSON.parse(fs.readFileSync(__dirname+'/manifest.json')).products;
const translations=JSON.parse(fs.readFileSync(__dirname+'/translations-ar.json'));
const saved=JSON.parse(fs.readFileSync(__dirname+'/result.json')).products;
const base='https://grocery.rocento.com';
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1100}});
 const report={product_count:saved.length,products:[],category:[]};
 try{
  for(let i=0;i<products.length;i++){
   const p=products[i],s=saved.find(s=>s.slug===p.slug),t=translations.find(t=>t.sku===p.sku).fields;
   for(const locale of ['en','ar']){
    const response=await context.request.get(base+'/api/v1/catalog/products/'+s.id,{headers:{'X-Storefront-Locale':locale}});
    assert.equal(response.status(),200);const item=await response.json();
    assert.equal(item.name,locale==='en'?p.name:t.name);assert.equal(item.description,locale==='en'?p.description:t.description);
    assert.equal(item.attributes.short_description,locale==='en'?p.attributes.short_description:t['attribute.short_description']);
    assert.equal(item.in_stock,true);assert.equal(item.active,true);
    for(const k of ['grocery-pack-size','grocery_group','ingredient_role','meal_occasion','preparation_method','dish_type'])assert.deepEqual(item.attributes[k],p.attributes[k]);
    assert.equal(item.media_ids[0],s.media_id);
   }
   const photo=await context.request.get(base+'/api/v1/catalog/media/'+s.media_id+'/content?width=480');
   assert.equal(photo.status(),200);assert.match(photo.headers()['content-type'],/^image\//);
   report.products.push({id:s.id,name:p.name,english:true,arabic:true,in_stock:true,image:true,attributes:true});
  }
  const page=await context.newPage();
  for(const locale of ['en','ar']){
   await page.goto(base+'/categories/grocery-meat-poultry?lang='+locale,{waitUntil:'networkidle'});
   const names=locale==='en'?products.map(p=>p.name):translations.map(t=>t.fields.name);
   for(const name of names)await page.getByRole('link',{name,exact:true}).first().waitFor();
   for(const s of saved){
    const photo=page.locator('a[href*="'+s.id+'"] img').first();
    await photo.scrollIntoViewIfNeeded();
    await photo.evaluate(img=>img.complete?Promise.resolve():new Promise((resolve,reject)=>{img.addEventListener('load',resolve,{once:true});img.addEventListener('error',reject,{once:true})}));
    assert(await photo.evaluate(img=>img.naturalWidth>0));
   }
   await page.evaluate(()=>window.scrollTo(0,0));
   await page.screenshot({path:__dirname+'/production-category-'+locale+'.png',fullPage:true});
   assert.equal(await page.locator('html').getAttribute('dir'),locale==='ar'?'rtl':'ltr');
   report.category.push({locale,ten_new_products_visible:true,ten_photos_loaded:true});
  }
  await page.goto(base+'/products/'+saved[0].id+'?lang=ar',{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:translations[0].fields.name,exact:true}).waitFor();
  await page.screenshot({path:__dirname+'/production-product-ar.png',fullPage:true});
  report.arabic_product_page=true;
  fs.writeFileSync(__dirname+'/public-verification.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
