import { gatewayFetch } from './transport.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPublicationServer, serializeState } from './publication.mjs';
const template = '<html lang="en"><head><title>Store</title></head><body><div id="root"><!--publication-html--></div><!--publication-state--></body></html>';
const snapshot = { schema_version:1,installation_id:'one',origin:'https://shop.example.test/',locale:'en',site_name:'Merchant',description:'Store',path:'/',page:1,status:200,robots:'index, follow',categories:[],metadata:{title:'Merchant',description:'Store',image:null},images:{} };
async function fixture(t, override = {}) {
  const calls = [];
  const server = createPublicationServer({origin:snapshot.origin,installationId:'one',gateway:'http://127.0.0.1:8080/',template,render:() => '<h1>Published catalog</h1>',fetcher:async (url,options) => { calls.push({url:String(url),options});return new Response(JSON.stringify(snapshot)); },...override});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(() => server.close());
  return { calls, port: server.address().port, get: (path='/', options={}) => gatewayFetch(`http://127.0.0.1:${server.address().port}${path}`, {redirect:'manual',...options,headers:{host:'shop.example.test',...options.headers}}) };
}
test('anonymous content, no-store and identical robots; credentials never forwarded',async t => {
  const {get,calls}=await fixture(t);const r=await get('/',{headers:{cookie:'customer_session=secret',authorization:'Bearer secret','x-delivery-location':'private'}});
  assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-robots-tag'),'index, follow');
  assert.match(await r.text(),/<h1>Published catalog<\/h1>/);assert.deepEqual(calls[0].options.headers,{host:'shop.example.test'});
});
test('unknown URLs, invalid pagination, methods and spoofed hosts fail closed',async t => {
  const {get,calls}=await fixture(t);
  for(const path of ['/unknown','/products/','/products/a/b','/?page=0','/?page=10001','/?page=2&page=3']) assert.equal((await get(path)).status,404);
  assert.equal((await get('/',{method:'POST'})).status,405);assert.equal((await get('/',{headers:{host:'attacker.test','x-forwarded-host':'shop.example.test'}})).status,421);assert.equal(calls.length,0);
});
test('mismatched installation/origin and unavailable backend produce 503, never empty success',async t => {
  for(const change of [{installation_id:'two'},{origin:'https://other.example.test/'},{locale:'bad locale'}]) {
    const {get}=await fixture(t,{fetcher:async()=>new Response(JSON.stringify({...snapshot,...change}))});assert.equal((await get()).status,503);
  }
  const {get}=await fixture(t,{fetcher:async()=>{throw new Error('timeout');}});assert.equal((await get()).status,503);
});
test('404, approved 410 and single-hop 301 preserve status and noindex',async t => {
  for(const status of [404,410,301]) {
    const {get}=await fixture(t,{fetcher:async()=>new Response(JSON.stringify({...snapshot,status,location:'/products/new'}))});const r=await get();assert.equal(r.status,status);assert.equal(r.headers.get('x-robots-tag'),'noindex, nofollow');if(status===301)assert.equal(r.headers.get('location'),'/products/new');
  }
});
test('query variants noindex and HEAD has no body',async t => {
  const {get}=await fixture(t);assert.equal((await get('/?campaign=x')).headers.get('x-robots-tag'),'noindex, nofollow');assert.equal(await (await get('/',{method:'HEAD'})).text(),'');
});
test('embedded state cannot close its script element',()=> {
  const state={text:'</script><script>alert(1)</script>\u2028'};const serialized=serializeState(state);assert.ok(!serialized.includes('<'));assert.deepEqual(JSON.parse(serialized),state);
});
test('startup rejects mismatched client/server artifacts before listening', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const directory = await mkdtemp(join(tmpdir(), 'publication-seal-'));t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'public.html'), template);await writeFile(join(directory, 'publication-build.json'), JSON.stringify({ schema_version:1, template:'wrong', server:'wrong' }));
  await assert.rejects(promisify(execFile)(process.execPath, [new URL('./start.mjs', import.meta.url).pathname], { env: { ...process.env, PUBLICATION_ARTIFACT_DIR:directory, PUBLICATION_SSR_ENTRY:new URL('./publication.mjs', import.meta.url).pathname } }), error => error.stderr.includes('Mismatched publication artifacts'));
});
test('canonical metadata and discovery placeholders share only the approved origin', async t => {
  const url='https://shop.example.test/';
  const canonical={installation_id:'one',locale:'en',path:'/',url,html:url,json_ld:url,sitemap:url,feed:url};
  const {get}=await fixture(t,{fetcher:async()=>new Response(JSON.stringify({...snapshot,canonical}))});
  const r=await get();assert.equal(r.status,200);assert.match(await r.text(),/<link rel="canonical" href="https:\/\/shop.example.test\/"\/>/);
  for(const change of [{url:'https://other.example/'},{installation_id:'two'},{html:'https://other.example/'},{locale:'ar'},{path:'//other.example/'}]) {
    const {get}=await fixture(t,{fetcher:async()=>new Response(JSON.stringify({...snapshot,canonical:{...canonical,...change}}))});assert.equal((await get()).status,503);
  }
});

test('raw encoded dot segments cannot normalize into a private 200 shell', async t => {
  const {port,calls}=await fixture(t);const {request}=await import('node:http');
  for(const path of ['/products/%2e%2e/account','/products/../account','/account%2flocations','/products/%ff']) {
    const status=await new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,headers:{host:'shop.example.test'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
    assert.equal(status,404,path);
  }
  assert.equal(calls.length,0);
});
test('discovery artifacts require the installation binding and preserve XML and HEAD', async t => {
  const seen=[];
  const {get}=await fixture(t,{fetcher:async(url,options)=>{seen.push(options.headers);return new Response('<urlset/>',{headers:{'x-publication-installation-id':'one'}});}});
  for(const path of ['/robots.txt','/sitemap.xml','/sitemaps/home.xml','/llms.txt']) {
    const r=await get(path,{headers:{cookie:'private=secret'}});assert.equal(r.status,200);assert.equal(await r.text(),'<urlset/>');assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-robots-tag'),'noindex, nofollow');
    assert.equal(await(await get(path,{method:'HEAD'})).text(),'');
  }
  assert.ok(seen.every(h=>Object.keys(h).join()==='host'));
  assert.equal((await get('/sitemap.xml?host=foreign')).status,404);
  const other=await fixture(t,{fetcher:async()=>new Response('foreign',{headers:{'x-publication-installation-id':'two'}})});
  assert.equal((await other.get('/sitemap.xml')).status,503);
});
test('comparison links load the interactive storefront shell',async t => {
  const {get,calls}=await fixture(t,{fetcher:async (url) => {calls.push(String(url));return new Response('<html>Comparison app shell</html>');}});
  const response=await get('/compare?products=00000000-0000-0000-0000-000000000001');
  assert.equal(response.status,200);
  assert.match(await response.text(),/Comparison app shell/);
  assert.ok(calls.some(url => url.includes('/compare?products=')));
});
test('interface drafts use a private no-store, noindex shell without publication data',async t=>{
  const requests=[];
  const {get}=await fixture(t,{fetcher:async(url)=>{requests.push(String(url));return new Response('<html>Interface preview shell</html>');}});
  const response=await get('/?interface_preview=ar&interface_channel=example');
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow');
  assert.match(await response.text(),/Interface preview shell/);assert.equal(requests.length,1);assert.ok(!requests[0].includes('/publication/snapshot'));
});
