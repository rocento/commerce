import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from 'node:zlib';
import { acceptedEncodings } from './compression.mjs';
import { createPublicationServer } from './publication.mjs';
import { gatewayFetch } from './transport.mjs';

test('compression honors quality weights and explicit exclusions', () => {
  assert.deepEqual(acceptedEncodings('gzip, br'), ['br', 'gzip']);
  assert.deepEqual(acceptedEncodings('br;q=0, gzip;q=0.5'), ['gzip']);
  assert.deepEqual(acceptedEncodings('gzip;q=1,br;q=0.5'), ['gzip', 'br']);
  assert.deepEqual(acceptedEncodings('br;q=0,gzip;q=0,*;q=1'), []);
  assert.deepEqual(acceptedEncodings('identity'), []);
});

test('HTML and static bundles negotiate compression with correct HEAD and cache semantics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'storefront-compression-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'));
  const bundle = 'console.log("storefront");'.repeat(200);
  await writeFile(join(directory, 'assets', 'app-test.js'), bundle);
  await writeFile(join(directory, 'assets', 'app-test.js.br'), brotliCompressSync(bundle));
  const snapshot = {schema_version:1,installation_id:'one',origin:'https://shop.example.test/',locale:'en',site_name:'Store',path:'/',page:1,status:200,robots:'index, follow',metadata:{title:'Store',description:'Groceries'},images:{}};
  const server = createPublicationServer({origin:snapshot.origin,installationId:'one',gateway:'http://127.0.0.1:1/',assetDirectory:directory,template:'<html lang="en"><head></head><body><!--publication-html--><!--publication-state--></body></html>',render:()=>'<p>Fresh groceries</p>'.repeat(200),fetcher:async()=>new Response(JSON.stringify(snapshot)),emitObservation:()=>{}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = (path, encoding, method='GET') => gatewayFetch(`http://127.0.0.1:${server.address().port}${path}`, {method,headers:{host:'shop.example.test','accept-encoding':encoding}});
  const html = await get('/', 'gzip');
  assert.equal(html.headers.get('content-encoding'), 'gzip');
  assert.equal(html.headers.get('cache-control'), 'no-store');
  assert.equal(html.headers.get('vary'), 'Accept-Encoding');
  assert.match(gunzipSync(Buffer.from(await html.arrayBuffer())).toString(), /Fresh groceries/);
  for (const encoding of ['br', 'gzip', 'identity', 'gzip;q=0,br;q=0']) {
    const response = await get('/assets/app-test.js', encoding);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    let bytes = Buffer.from(await response.arrayBuffer());
    if (encoding === 'br') { assert.equal(response.headers.get('content-encoding'), 'br'); bytes = brotliDecompressSync(bytes); }
    else if (encoding === 'gzip') { assert.equal(response.headers.get('content-encoding'), 'gzip'); bytes = gunzipSync(bytes); }
    else assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(bytes.toString(), bundle);
    const head = await get('/assets/app-test.js', encoding, 'HEAD');
    assert.equal(head.headers.get('content-encoding'), response.headers.get('content-encoding'));
    assert.equal(await head.text(), '');
  }
  assert.equal((await get('/assets/missing.js', 'br')).status, 404);
  assert.equal((await get('/assets/../secret', 'br')).status, 404);
});
