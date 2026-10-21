// Local before/after fixture with approved demo artwork and production-encoded WebP.
// No production requests, accounts, cart writes or analytics leave this process.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
const repository = resolve('..');
const build = resolve('apps/storefront/dist');
const budget = JSON.parse(await readFile(resolve(repository, 'output/electronics-performance/image-budget.json'), 'utf8'));
const catalog = JSON.parse(await readFile('apps/storefront/src/interface-messages.json', 'utf8'));
const images = Object.fromEntries(budget.map(image => [image.id, { ...image, alt: image.name, variants: image.variants.map(({width,height})=>({width,height})) }]));
const configuration = JSON.parse(await readFile(resolve(repository, 'commerce-demo/electronics/theme.json'), 'utf8'), (_key,value) => {
  if (typeof value !== 'string') return value;
  if (value.startsWith('asset:electronics/')) return budget.find(i=>value===`asset:electronics/${i.name}.png`)?.id || null;
  if (value.startsWith('category-link:') || value.startsWith('product-link:')) return '/search';
  if (value.startsWith('category:')) return '';
  return value;
});
const categories = budget.map((image,index)=>({id:`00000000-0000-4000-8000-00000000000${index+1}`,slug:image.name,name:image.name,parent_id:null,thumbnail:image.id,attributes:{}}));
const product = (image,index,optimized)=>({id:`10000000-0000-4000-8000-00000000000${index+1}`,name:`Demo ${image.name}`,description:'Illustrative technology',price:'99.00',currency:'USD',unit:'each',sku:image.name,slug:image.name,product_type:'simple',category_id:categories[index].id,parent_id:null,media_ids:[image.id],in_stock:true,attributes:{brand:'Rocento Tech'},...(optimized?{images:{[image.id]:images[image.id]}}:{})});
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.ico':'image/x-icon','.ttf':'font/ttf','.webmanifest':'application/manifest+json'};
function start(port,optimized) {
  createServer(async(req,res)=>{
    const send=(body,type='application/json',status=200)=>{
      body=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
      const headers={'content-type':type,'cache-control':'no-store','x-robots-tag':'noindex, nofollow'};
      if(/^(text\/|application\/json)/.test(type)&&req.headers['accept-encoding']?.includes('gzip')) {body=gzipSync(body);headers['content-encoding']='gzip';headers.vary='Accept-Encoding';}
      res.writeHead(status,headers);res.end(body);
    };
    try {
      const url=new URL(req.url,'http://localhost');
      const media=/^\/api\/v1\/catalog\/media\/([0-9a-f-]+)\/content$/.exec(url.pathname);
      if(media) {
        const image=budget.find(i=>i.id===media[1]);
        if(!image)return send({},'application/json',404);
        const width=url.searchParams.get('width');
        if(width&&(!optimized||!image.variants.some(v=>String(v.width)===width)))return send({},'application/json',404);
        const path=width?resolve(repository,`commerce-output/electronics-performance/images/${image.name}-${width}.webp`):resolve(repository,`commerce-assets/demo/electronics/${image.name}.png`);
        return send(await readFile(path),width?'image/webp':'image/png');
      }
      if(url.pathname.startsWith('/api/')) {
        if(url.pathname.endsWith('/auth/refresh'))return send({error:'Signed out'},'application/json',401);
        if(url.pathname.includes('/cart'))return send({id:'00000000-0000-4000-8000-000000000099',items:[],subtotal:'0',total:'0',currency:'USD'});
        if(req.method!=='GET')return send({});
        if(url.pathname.includes('/theme/'))return send({configuration,cities:[],...(optimized?{images}:{})});
        if(url.pathname.endsWith('/languages/interface'))return send({revision:1,catalog_version:'fixture',overrides:[],messages:catalog.messages.map(m=>({plural:null,...m}))});
        if(url.pathname.endsWith('/languages'))return send({source_locale:'en',languages:[]});
        if(url.pathname.endsWith('/catalog/categories'))return send(categories.map(c=>({...c,...(optimized?{images:{[c.thumbnail]:images[c.thumbnail]}}:{})})));
        if(url.pathname.endsWith('/search'))return send({hits:budget.map((image,index)=>product(image,index,optimized)),total:4,facets:{}});
        if(url.pathname.endsWith('/cart'))return send({id:'00000000-0000-4000-8000-000000000099',items:[],subtotal:'0',total:'0',currency:'USD'});
        if(url.pathname.endsWith('/delivery-area'))return send({configured:false,deliverable:true});
        if(url.pathname.endsWith('/capabilities'))return send({geo_fencing_enabled:false});
        if(url.pathname.includes('/content/'))return send({error:'No content'},'application/json',404);
        return send([]);
      }
      let path=resolve(build,'.'+decodeURIComponent(url.pathname));
      if(path!==build&&!path.startsWith(build+'/'))return send({},'application/json',404);
      let bytes;
      try {bytes=await readFile(path);} catch {
        if(extname(path))return send({},'application/json',404);
        path=resolve(build,'index.html');bytes=await readFile(path);
      }
      send(bytes,types[extname(path)]||'application/octet-stream');
    } catch {send({error:'Fixture unavailable'},'application/json',503);}
  }).listen(port,'127.0.0.1',()=>console.log(`${optimized?'Optimized':'Original'} Electronics fixture: http://127.0.0.1:${port}`));
}
start(4185,false);start(4186,true);
