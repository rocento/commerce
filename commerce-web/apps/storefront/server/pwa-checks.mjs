import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createPublicationServer } from './publication.mjs';
import { gatewayFetch } from './transport.mjs';

test('installation assets work without the commerce backend and retain host/method restrictions', async t => {
  const server = createPublicationServer({
    origin: 'https://shop.example.test/', installationId: 'one', gateway: 'http://127.0.0.1:8080/',
    template: '<!--publication-html--><!--publication-state-->', render: () => '',
    assetDirectory: fileURLToPath(new URL('../public', import.meta.url)),
    fetcher: async () => { throw new Error('Installation must not call commerce APIs'); },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const get = (path, options = {}) => gatewayFetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options, headers: { host: 'shop.example.test', ...options.headers },
  });
  const response = await get('/manifest.webmanifest');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/manifest+json');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  const manifest = await response.json();
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const image = await get(icon.src);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
  }
  assert.equal((await get('/brand/apple-touch-icon.png')).status, 200);
  const head = await get('/manifest.webmanifest', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await get('/manifest.webmanifest', { method: 'POST' })).status, 405);
  assert.equal((await get('/manifest.webmanifest', { headers: { host: 'other.example.test' } })).status, 421);
  assert.equal((await get('/brand/missing.png')).status, 404);
});
