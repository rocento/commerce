import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { takeThemeWarmup } from './theme-warmup';
import { mediaImageProps, type CatalogImage } from '@commerce/api-client';
const source = readFileSync(new URL('./early-theme.js', import.meta.url), 'utf8')
  .replace('__WARMUP_CHANNEL__', '"storefront"')
  .replace('__WARMUP_DEFAULT_HERO__', '{"src":"/hero-800.webp","srcSet":"/hero-480.webp 480w, /hero-800.webp 800w","sizes":"50vw"}');
const result = { configuration: { schema_version:'theme/v1', global:{top:[]}, pages:{home:[{enabled:true,component:'hero',settings:{}}]} }, cities:[], version_id:null };
function start(pathname = '/', search = '', city = '', response: unknown = result, guest = '') {
  const window: { __storefrontThemeWarmup?: { promise: Promise<unknown> } } = {};
  const append = vi.fn();
  const fetch = vi.fn().mockResolvedValue({ok:true,json:async()=>response});
  runInNewContext(source, {window, location:{pathname,search}, sessionStorage:{getItem:(key:string)=>key==='commerce-theme-city'?city:guest}, URLSearchParams, AbortController,
    document:{createElement:()=>({}),head:{append}}, Date, fetch, setTimeout:vi.fn(), clearTimeout:vi.fn()});
  return {window,append,fetch};
}
afterEach(() => vi.unstubAllGlobals());
it('starts the homepage theme independently and preloads only the selected hero', async () => {
  const {window,fetch,append}=start();
  expect(fetch).toHaveBeenCalledWith('/api/v1/theme/storefront', expect.objectContaining({credentials:'include',headers:expect.objectContaining({'x-delivery-context':'1'})}));
  await window.__storefrontThemeWarmup!.promise;
  expect(append.mock.calls[0][0]).toEqual(expect.objectContaining({rel:'preload',as:'fetch',href:'/api/v1/theme/storefront',crossOrigin:'use-credentials',fetchPriority:'high'}));
  expect(append).toHaveBeenCalledWith(expect.objectContaining({rel:'preload',as:'image',href:'/hero-800.webp',fetchPriority:'high'}));
});
it.each([['/checkout','',''],['/','?theme_preview=draft',''],['/','?interface_preview=ar',''],['/','','Cairo']])('skips non-home and personalized preview contexts', (path,search,city) => {
  const started = start(path,search,city);
  expect(started.fetch).not.toHaveBeenCalled();
  expect(started.append).not.toHaveBeenCalled();
});
it('does not preload a default hero for a text-only or malformed theme', async () => {
  for(const data of [{}, {...result, configuration:{...result.configuration,pages:{home:[]}}}]) {
    const started=start('/','','',data);await started.window.__storefrontThemeWarmup!.promise;expect(started.append.mock.calls.map(call=>call[0].as)).toEqual(['fetch']);
  }
});
it('does not fetch an unscoped theme or hero for a returning delivery shopper', () => {
  const started = start('/', '', '', result, JSON.stringify({latitude:30,longitude:31,formatted_address:'Demo area'}));
  expect(started.fetch).not.toHaveBeenCalled();
  expect(started.append).not.toHaveBeenCalled();
});
it('preloads the same responsive jewelry hero candidates as the rendered SPA', async () => {
  const id = 'dd688e36-7062-45c6-968d-696f0829faa6';
  const metadata: CatalogImage = { id, alt: 'Ring', width: 1024, height: 1024, variants: [{ width: 480, height: 480 }, { width: 960, height: 960 }] };
  const started = start('/', '', '', { ...result, images: { [id]: metadata }, configuration: { ...result.configuration, global: { top: [{ enabled: true, component: 'presentation', settings: { style: 'heritage' } }] }, pages: { home: [{ enabled: true, component: 'editorial_hero', settings: { image: id } }] } } });
  await started.window.__storefrontThemeWarmup!.promise;
  expect(started.append).toHaveBeenCalledWith(expect.objectContaining({ href: mediaImageProps(id, metadata).src, imageSrcset: mediaImageProps(id, metadata).srcSet, imageSizes: '100vw' }));
});
it('preloads the original for old theme media without a rendition manifest', async () => {
  const id = 'dd688e36-7062-45c6-968d-696f0829faa6';
  const started = start('/', '', '', { ...result, configuration: { ...result.configuration, pages: { home: [{ enabled: true, component: 'editorial_hero', settings: { image: id } }] } } });
  await started.window.__storefrontThemeWarmup!.promise;
  expect(started.append).toHaveBeenCalledWith(expect.objectContaining({ href: mediaImageProps(id).src }));
  expect(started.append.mock.calls.find(call=>call[0].as==='image')![0].imageSrcset).toBeUndefined();
});
it('preloads Electronics WebP candidates with exactly the same URLs as the rendered hero', async () => {
  const id = 'ee139d18-0f50-4a0e-be41-344f5f60662b';
  const metadata: CatalogImage = { id, alt: 'Phone', width: 1254, height: 1254, variants: [{width:480,height:480},{width:960,height:960},{width:1254,height:1254}] };
  const started = start('/', '', '', { ...result, images: {[id]:metadata}, configuration: { ...result.configuration, global: {top:[{enabled:true,component:'presentation',settings:{style:'showcase'}}]}, pages:{home:[{enabled:true,component:'editorial_hero',settings:{image:id}}]} } });
  await started.window.__storefrontThemeWarmup!.promise;
  const image = mediaImageProps(id, metadata);
  expect(started.append).toHaveBeenCalledWith(expect.objectContaining({href:image.src,imageSrcset:image.srcSet,imageSizes:'(max-width: 640px) 100vw, 50vw'}));
});
it.each([
  ['storefront','', 'none',false,true],['different','', 'none',false,false],['storefront','Cairo','none',false,false],
  ['storefront','', '30,31',false,false],['storefront','', 'none',true,false],
])('reuses the request only for its exact anonymous context', (channel,city,delivery,auth,reuse) => {
  const promise=Promise.resolve(null);
  vi.stubGlobal('window',{__storefrontThemeWarmup:{channel:'storefront',started:Date.now(),promise}});
  expect(takeThemeWarmup(String(channel),String(city),String(delivery),Boolean(auth))).toBe(reuse ? promise : undefined);
  expect(takeThemeWarmup('storefront','','none',false)).toBeUndefined();
});
it('never reuses an old response', () => {
  vi.stubGlobal('window',{__storefrontThemeWarmup:{channel:'storefront',started:Date.now()-20_000,promise:Promise.resolve(result)}});
  expect(takeThemeWarmup('storefront','','none',false)).toBeUndefined();
});
