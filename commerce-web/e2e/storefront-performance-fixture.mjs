// Deterministic frontend fixture; does not measure production backend latency.
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.env.STOREFRONT_BUILD_ROOT || 'apps/storefront');
const { createPublicationServer } = await import(pathToFileURL(resolve(root, 'server/publication.mjs')));
const { render } = await import(pathToFileURL(resolve(root, 'dist-server/entry-public-server.js')));
const contract = JSON.parse(await readFile(new URL('../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8'));
const theme = structuredClone(contract.default);
const imageId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000002';
for (const section of theme.pages.home) if (section.component === 'hero') section.settings.image = imageId;
const product = {id:productId, slug:'apples', name:'Orchard apples', description:'Fresh crisp apples, picked with care. A delicious everyday essential for your family.', price:'3.25', currency:'USD', unit:'kg', sku:'APPLE', product_type:'simple', category_id:'fruit', image_id:imageId, image_alt:'Fresh apples', attributes:{Origin:'Local orchard'}, parent_id:null, offer_eligible:true, price_diagnostic:''};
const products = Array.from({length:12}, (_,i) => ({...product,id:i ? `product-${i}`:product.id,slug:i?`apples-${i}`:'apples',name:i?`Orchard selection ${i}`:product.name}));
const origin='https://shop.example.test/';
function snapshot(path) {
  const canonical = origin.slice(0,-1)+path;
  return {schema_version:1,installation_id:'performance',origin,locale:'en',site_name:'Orchard Market',description:'Fresh groceries delivered',path,kind:path==='/'?'home':path.startsWith('/categories/')?'category':'product',status:200,location:null,canonical:{installation_id:'performance',locale:'en',path,url:canonical,html:canonical,json_ld:canonical,sitemap:canonical,feed:canonical},robots:'index, follow',theme,categories:[{id:'fruit',slug:'fruit',name:'Fresh fruit',description:'Fresh seasonal favorites',thumbnail:imageId,parent_id:null}],category_id:'fruit',products,collections:Object.fromEntries(theme.pages.home.map(s=>[s.id,products.slice(0,8)])),product:path.startsWith('/products/')?product:null,content:null,page:1,has_next:false,availability:'Choose a delivery location to confirm availability.',guides:[],family:[],variant_dimensions:[],parent_product:null,structured_data:null,images:{[imageId]:{id:imageId,width:1024,height:1024,alt:'Fresh apples',variants:[]}},metadata:{title:path==='/'?'Orchard Market':path.startsWith('/categories/')?'Fresh fruit':'Orchard apples',description:'Fresh groceries from Orchard Market',image:imageId,warnings:[]}};
}
const publication = createPublicationServer({origin,installationId:'performance',gateway:'http://127.0.0.1:1/',template:await readFile(resolve(root,'dist/public.html'),'utf8'),render,assetDirectory:resolve(root,'dist'),emitObservation:()=>{},fetcher:async url=>new Response(JSON.stringify(snapshot(new URL(url).searchParams.get('path')||'/')))});
publication.listen(0,'127.0.0.1');await once(publication,'listening');
const image = await readFile(new URL('../apps/storefront/src/theme-default.webp',import.meta.url));
const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/api/v1/catalog/media/')){res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'public, max-age=86400'});return res.end(image);}
  if(req.url.startsWith('/api/v1/search')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({hits:[{...product,media_ids:[imageId],in_stock:true}],total:1,facets:{}}));}
  if(req.url.startsWith('/api/')){res.setHeader('Content-Type','application/json');return res.end('{}');}
  const upstream=http.request({hostname:'127.0.0.1',port:publication.address().port,path:req.url,method:req.method,headers:{...req.headers,host:'shop.example.test'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  upstream.on('error',()=>{res.writeHead(503);res.end();});req.pipe(upstream);
});
server.listen(Number(process.env.PERFORMANCE_PORT || 4179),'127.0.0.1');await once(server,'listening');
console.log(`Performance fixture: http://127.0.0.1:${server.address().port} (${root})`);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();publication.close();});
