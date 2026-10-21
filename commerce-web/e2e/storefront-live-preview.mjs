// Read-only live catalog preview of a local production SPA build.
// Only public GET catalog/theme/content/delivery data reaches the upstream.
// Auth, cart, analytics and all writes receive local test responses.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
const root = resolve(process.env.STOREFRONT_DIST || 'apps/storefront/dist');
const upstream = new URL(process.env.STOREFRONT_ORIGIN || 'https://grocery.rocento.com');
const cache = new Map();
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.png':'image/png','.ico':'image/x-icon','.json':'application/json','.webmanifest':'application/manifest+json','.ttf':'font/ttf'};
const send = (req,res,status,body,type) => {
  const headers={'content-type':type,'cache-control':'no-cache','x-robots-tag':'noindex, nofollow'};
  if (/^(text\/|application\/json)/.test(type) && req.headers['accept-encoding']?.includes('gzip')) { body=gzipSync(body); headers['content-encoding']='gzip'; headers.vary='Accept-Encoding'; }
  res.writeHead(status,headers);res.end(body);
};
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')) {
      if(url.pathname==='/api/v1/cart')return send(req,res,200,Buffer.from(JSON.stringify({id:'00000000-0000-4000-8000-000000000000',items:[],subtotal:'0',total:'0',currency:'USD'})),'application/json');
      if(req.method!=='GET') return send(req,res,url.pathname.endsWith('/auth/refresh')?401:200,Buffer.from('{}'),'application/json');
      if(!/^\/api\/v1\/(theme\/|catalog\/|search(?:\?|$)|content\/|delivery-area|fulfillment\/capabilities)/.test(url.pathname+url.search)) return send(req,res,200,Buffer.from('[]'),'application/json');
      const key=url.pathname+url.search;
      if(!cache.has(key))cache.set(key,fetch(new URL(key,upstream),{signal:AbortSignal.timeout(15000)}).then(async r=>({status:r.status,type:r.headers.get('content-type')||'application/json',bytes:Buffer.from(await r.arrayBuffer())})).catch(error=>{cache.delete(key);throw error;}));
      const result=await cache.get(key);
      return send(req,res,result.status,result.bytes,result.type);
    }
    let path=resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!path.startsWith(root+'/')&&path!==root)throw new Error('Invalid path');
    let body;
    try {body=await readFile(path);}catch {
      if(extname(path))return send(req,res,404,Buffer.from('Not found'),'text/plain');
      path=resolve(root,'index.html');body=await readFile(path);
    }
    send(req,res,200,body,types[extname(path)]||'application/octet-stream');
  } catch {send(req,res,503,Buffer.from('Preview unavailable'),'text/plain');}
});
server.listen(Number(process.env.PERFORMANCE_PORT||4182),'127.0.0.1',()=>console.log(`SPA preview ${root}: http://127.0.0.1:${server.address().port}`));
