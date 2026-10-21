import { entryCookie } from './entry-attribution.mjs';
import { acceptedEncodings, sendBody } from './compression.mjs';
import { timingSafeEqual } from 'node:crypto';
import { createObservations } from './observability.mjs';
import { runHealth } from './health.mjs';
import { structuredDataScript } from './structured-data.mjs';
import { metadataHead } from './metadata.mjs';
import { gatewayFetch } from './transport.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicPath, publicTarget, canonicalTarget, validDestination, decodedRequestPath } from './url-policy.mjs';
export { publicPath } from './url-policy.mjs';
export const privatePath = path => /^\/(compare|search|cart|checkout|delivery-location|login|register|verify|forgot-password|reset-password|assistant|support)$/.test(path) || /^\/account(?:\/(?:wishlist|tickets|orders|locations|addresses)(?:\/[A-Za-z0-9_-]+)?)?$/.test(path);
export const serializeState = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const noindex = 'noindex, nofollow';
export function createPublicationServer({ origin, installationId, gateway, template, render, assetDirectory, fetcher = gatewayFetch, observationToken, emitObservation, maxConcurrent = 32 }) {
  const approved = new URL(origin), backend = new URL(gateway);
  if (approved.protocol !== 'https:' || approved.pathname !== '/' || approved.search || approved.hash || approved.username || approved.password || approved.port) throw new Error('Expected root HTTPS origin');
  if (!['http:', 'https:'].includes(backend.protocol) || backend.pathname !== '/' || backend.search || backend.hash || backend.username || backend.password) throw new Error('Expected fixed backend origin');
  if (!installationId || !template.includes('<!--publication-html-->') || !template.includes('<!--publication-state-->')) throw new Error('Missing installation binding or template');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 256) throw new Error('Invalid publication concurrency limit');
  let inflight = 0;
  const observations = createObservations(installationId, emitObservation);
  const server = createServer(async (req, res) => {
    let admitted = false;
    let failureCode = 'response';
    res.on('finish', () => observations.record({ path: req.url, status: res.statusCode, userAgent: req.headers['user-agent'], code: res.statusCode>=500||res.statusCode===421?failureCode:'response' }));
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', noindex); res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body, type = 'text/html; charset=utf-8') => { if(status===301&&req.method==='GET'){const cookie=entryCookie(req.url,req.headers.referer,req.headers);if(cookie)res.setHeader('Set-Cookie',cookie);} res.statusCode = status; res.setHeader('Content-Type', type); sendBody(req, res, body, type); };
    const fail = (status, title) => send(status, `<!doctype html><html><head><meta name="robots" content="${noindex}"/><title>${title}</title></head><body><main><h1>${title}</h1><a href="/">Return to the store</a></main></body></html>`);
    const disconnected = new AbortController();
    res.on('close', () => { if (!res.writableEnded) disconnected.abort(); });
    try {
      const hosts = req.rawHeaders.filter((_, i) => i % 2 === 0).filter(name => name.toLowerCase() === 'host');
      if (hosts.length !== 1 || ![approved.hostname, `${approved.hostname}:443`].includes(req.headers.host?.toLowerCase())) { failureCode='unknown_canonical_host'; return fail(421, 'Unrecognized storefront host'); }
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return fail(405, 'Method not allowed'); }
      if (decodedRequestPath(req.url) === null) return fail(404, 'Page not found');
      const url = new URL(req.url, origin);
      if (url.origin !== approved.origin) { failureCode='unknown_canonical_host'; return fail(421, 'Unrecognized storefront host'); }
      const installAssetType = {
        '/manifest.webmanifest': 'application/manifest+json',
        '/brand/icon-192.png': 'image/png',
        '/brand/icon-512.png': 'image/png',
        '/brand/apple-touch-icon.png': 'image/png',
      }[url.pathname];
      if (installAssetType && assetDirectory) {
        try {
          const asset = await readFile(resolve(assetDirectory, `.${url.pathname}`));
          res.setHeader('Cache-Control', 'no-cache');
          return send(200, asset, installAssetType);
        } catch { return fail(404, 'Page not found'); }
      }
      if (url.pathname !== '/health' && !url.pathname.startsWith('/assets/')) {
        if (inflight >= maxConcurrent) { res.setHeader('Retry-After', '1'); return fail(503, 'Storefront temporarily busy'); }
        inflight++; admitted = true;
      }
      if (url.pathname === '/__publication/health') {
        const supplied = req.headers['x-publication-observation-token'];
        if (!observationToken || observationToken.length < 32 || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(observationToken) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(observationToken))) return fail(404, 'Page not found');
        const address=server.address();
        const probe = path => fetcher(new URL(path, `http://127.0.0.1:${address.port}`), {headers:{host:approved.hostname,'user-agent':'Rocento-Publication-Health'},signal:AbortSignal.timeout(2000)});
        const snapshot = async path => {const r=await fetcher(new URL(`/v1/publication/snapshot?${new URLSearchParams({path})}`,backend),{headers:{host:approved.hostname},signal:AbortSignal.timeout(2000)});if(r.status!==200)throw new Error('snapshot');return r.json();};
        // Only an operator-selected canonical local path can be sampled; no arbitrary URL input.
        const redirectPath=url.searchParams.get('redirect');
        if(redirectPath && (!/^\/(products|categories|pages)\/[A-Za-z0-9_-]{1,200}$/.test(redirectPath))) return fail(400,'Invalid health sample');
        const report=await runHealth({origin,installationId,get:probe,snapshot,observations,redirectPath,imageGet:path=>fetcher(new URL(path.replace(/^\/api\//,'/'),backend),{method:'HEAD',headers:{host:approved.hostname},signal:AbortSignal.timeout(2000)})});
        return send(200,JSON.stringify(report),'application/json');
      }
      if (url.pathname.startsWith('/assets/') && assetDirectory) {
        if (!/^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname)) return fail(404, 'Page not found');
        const file = resolve(assetDirectory, `.${url.pathname}`);
        try {
          let asset;
          if (/\.(js|css)$/.test(file)) {
            res.setHeader('Vary', 'Accept-Encoding');
            for (const encoding of acceptedEncodings(req.headers['accept-encoding'])) {
              try {
                asset = await readFile(`${file}.${encoding === 'br' ? 'br' : 'gz'}`);
                res.setHeader('Content-Encoding', encoding);
                break;
              } catch { /* Older builds can still serve the original bundle. */ }
            }
          }
          asset ??= await readFile(file);
          const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); return send(200, asset, type);
        } catch { return fail(404, 'Page not found'); }
      }
      const get = (path, timeout = 5000) => fetcher(new URL(path, backend), { headers: { host: approved.hostname }, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(timeout), disconnected.signal]) });
      if (url.pathname === '/health') return send(200, '{"status":"ok"}', 'application/json');
      if (url.pathname === '/ready') {
        const r = await get('/v1/publication/snapshot?path=%2F');
        if (r.status !== 200) return fail(503, 'Storefront temporarily unavailable');
        const s = await r.json();
        if (s.installation_id !== installationId || s.origin !== origin || s.schema_version !== 1) return fail(503, 'Storefront temporarily unavailable');
        return send(200, '{"status":"ready"}', 'application/json');
      }
      if (['/robots.txt', '/sitemap.xml', '/llms.txt'].includes(url.pathname) || /^\/sitemaps\/[A-Za-z0-9-]+\.xml$/.test(url.pathname)) {
        if (url.search) return fail(404, 'Page not found');
        failureCode='sitemap_failure';
        const r = await get(url.pathname, 25000);
        if (r.status === 200 && r.headers.get('x-publication-installation-id') !== installationId) throw new Error('Invalid discovery binding');
        if(r.status<500)failureCode='response';
        return send(r.status, await r.text(), url.pathname.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8');
      }
      if (publicPath(url.pathname) && [...url.searchParams.keys()].some((key, index, keys) => keys.indexOf(key) !== index)) return fail(404, 'Page not found');
      if (privatePath(url.pathname) || (publicPath(url.pathname) && (url.searchParams.has('theme_preview') || url.searchParams.has('interface_preview')))) {
        const r = await get(url.pathname + url.search);
        if (r.status !== 200) return fail(503, 'Storefront temporarily unavailable');
        return send(200, await r.text());
      }
      const shopping = publicPath(url.pathname) && url.pathname.startsWith('/products/') && url.searchParams.get('shop') === '1';
      const target = publicTarget(shopping ? url.pathname : req.url);
      if (!target) return fail(404, 'Page not found');
      const { path, page } = target;
      failureCode='render_failure';
      const [r, interfaceBundle] = await Promise.all([
        get(`/v1/publication/snapshot?${new URLSearchParams({ path, page: String(page) })}`),
        get('/v1/languages/interface', 2000).then(response=>response.ok?response.json():undefined).catch(()=>undefined),
      ]);
      if (r.status !== 200) return fail(503, 'Storefront temporarily unavailable');
      let s = await r.json();
      const bound = snapshot => snapshot.schema_version === 1 && snapshot.installation_id === installationId && snapshot.origin === origin && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(snapshot.locale) && [200,301,404,410].includes(snapshot.status);
      failureCode='tenant_resolution_failure';
      if (!bound(s) || s.path !== path || s.page !== page) throw new Error('Invalid snapshot');
      failureCode='render_failure';
      if (target.locale !== null && target.locale !== s.locale) return fail(404, 'Page not found');
      if (shopping) {
        // The legacy purchase app calls ID APIs. Its explicit private URL is not a canonical document.
        if (s.status === 301) {
          if (!validDestination(s.location)) throw new Error('Invalid redirect');
          const expected = s.location;
          const next = await get(`/v1/publication/snapshot?${new URLSearchParams({ path: expected })}`);
          if (next.status !== 200) throw new Error('Unavailable product');
          s = await next.json(); if (!bound(s) || s.path !== expected || s.page !== 1) throw new Error('Invalid snapshot');
        }
        if ([404,410].includes(s.status)) return fail(s.status, s.status === 410 ? 'Page permanently removed' : 'Page not found');
        if (s.status !== 200 || !s.product?.id || !/^[0-9a-f-]{36}$/.test(s.product.id)) throw new Error('Invalid shopping resource');
        const privateURL = `/products/${s.product.id}?shop=1`;
        if (req.url !== privateURL) { res.setHeader('Location', privateURL); return send(301, 'Open the shopping view.'); }
        const shell = await get(privateURL); if (shell.status !== 200) throw new Error('Unavailable shopping view');
        return send(200, await shell.text());
      }
      if (s.status === 301) { if (!validDestination(s.location) || s.location === req.url) throw new Error('Invalid redirect'); res.setHeader('Location', s.location); return send(301, 'This page has moved.'); }
      const normalized = canonicalTarget(path,page);
      if (s.status === 200 && req.url !== normalized) { res.setHeader('Location', normalized); return send(301, 'This page has moved.'); }
      if (s.canonical != null) {
        const c = s.canonical;
        if (s.status !== 200 || c.installation_id !== installationId || c.locale !== s.locale || c.path !== normalized || c.url !== origin.slice(0,-1) + normalized || !['html','json_ld','sitemap','feed'].every(key => c[key] === c.url)) throw new Error('Invalid canonical identity');
      }
      const robots = s.status === 200 && s.robots === 'index, follow' ? 'index, follow' : noindex;
      s.robots = robots;
      failureCode='invalid_structured_data';
      const structured = structuredDataScript(s);
      failureCode='render_failure';
      // Saved merchant phrases are embedded for SSR and hydration. The client
      // validates the bundle and keeps refreshing it for already-open pages.
      if (interfaceBundle) s.interface_bundle = interfaceBundle;
      const html = render(s), state = `<script id="publication-state" type="application/json">${serializeState(s)}</script>`;
      const document = template.replace('lang="en"', `lang="${s.locale}"`).replace(/<title>.*?<\/title>/s, '').replace('</head>', () => `${metadataHead(s)}${structured}<!--publication-metadata--></head>`).replace('<!--publication-html-->', () => html).replace('<!--publication-state-->', () => state);
      failureCode='response';
      res.setHeader('X-Robots-Tag', robots); return send(s.status, document);
    } catch { return fail(503, 'Storefront temporarily unavailable'); }
    finally { if (admitted) inflight--; }
  });
  return server;
}
