// Isolated category preview using approved Grocery thumbnails and the built storefront.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=resolve('..'),build=resolve('apps/storefront/dist');
const {render}=await import(pathToFileURL(resolve('apps/storefront/dist-server/entry-public-server.js')));
const contract=JSON.parse(await readFile('packages/api-client/src/theme-contract.json','utf8'));
const preset=JSON.parse(await readFile(resolve(root,'commerce-demo/grocery/preset.json'),'utf8'));
const configuration=structuredClone(contract.default);
configuration.pages.home=configuration.pages.home.filter(s=>s.component==='category_grid');
const images={};
const categories=preset.categories.map((c,index)=>{
  const id=`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`;
  images[id]={id,alt:c.name,width:320,height:320,variants:[{width:320,height:320}]};
  return {...c,id,parent_id:null,thumbnail:id,attributes:{},images:{[id]:images[id]}};
});
const assetTypes={'.js':'text/javascript','.css':'text/css','.html':'text/html','.webp':'image/webp','.ttf':'font/ttf','.png':'image/png'};
const server=createServer(async(req,res)=>{
  const send=(body,type='application/json',status=200)=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store'});res.end(Buffer.isBuffer(body)||typeof body==='string'?body:JSON.stringify(body));};
  try {
    const url=new URL(req.url,'http://localhost');
    const media=/\/catalog\/media\/([^/]+)\/content$/.exec(url.pathname);
    if(media){const index=categories.findIndex(c=>c.id===media[1]);if(index<0)return send({},'application/json',404);return send(await readFile(resolve(root,'commerce-assets/demo',preset.categories[index].thumbnail)),'image/webp');}
    if(url.pathname.startsWith('/api/')){
      if(url.pathname.includes('/auth/refresh'))return send({error:'Signed out'},'application/json',401);
      if(url.pathname.includes('/theme/'))return send({configuration,cities:[],images});
      if(url.pathname.endsWith('/catalog/categories'))return send(categories);
      if(url.pathname.endsWith('/catalog/category-availability'))return send(Object.fromEntries(categories.map(c=>[c.id,1])));
      if(url.pathname.includes('/cart'))return send({id:'demo',items:[],subtotal:'0',total:'0',currency:'USD'});
      if(url.pathname.endsWith('/search'))return send({hits:[],facets:{},total:0});
      if(url.pathname.endsWith('/delivery-area'))return send({configured:false,deliverable:true});
      if(url.pathname.endsWith('/languages/interface'))return send({revision:0,messages:[],overrides:[]});
      if(url.pathname.endsWith('/languages'))return send({source_locale:'en',languages:[]});
      return send([]);
    }
    if(url.pathname==='/published'){
      const locale=url.searchParams.get('lang')==='ar'?'ar':'en';
      const snapshot={schema_version:1,installation_id:'fixture',origin:'https://shop.example.test/',locale,site_name:'Rocento',path:'/',kind:'home',status:200,theme:{...configuration,global:{top:[],bottom:[]}},categories,category_id:null,products:[],collections:{},product:null,content:null,page:1,has_next:false,guides:[],family:[],variant_dimensions:[],images,metadata:{warnings:[]},merchant:null};
      let template=await readFile(resolve(build,'public.html'),'utf8');
      template=template.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('<!--publication-html-->',render(snapshot));
      return send(template,'text/html');
    }
    const path=resolve(build,'.'+decodeURIComponent(url.pathname));
    if(!path.startsWith(build+'/')&&path!==build)return send({},'application/json',404);
    let bytes;
    try{bytes=await readFile(path);}catch{if(extname(path))return send({},'application/json',404);bytes=await readFile(resolve(build,'index.html'));}
    if(!extname(path)||extname(path)==='.html')bytes=Buffer.from(bytes.toString().replace('<head>',`<head><script>sessionStorage.setItem('commerce-guest-location',JSON.stringify({latitude:30,longitude:31,formatted_address:'Demo area',label:'home'}));</script>`));
    send(bytes,assetTypes[extname(path)]||(!extname(path)?'text/html':'application/octet-stream'));
  }catch(error){console.error(error.message);send({},'application/json',503);}
});
server.listen(4187,'127.0.0.1',()=>console.log('Category layout fixture: http://127.0.0.1:4187'));
