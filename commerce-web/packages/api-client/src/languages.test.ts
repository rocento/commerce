import { afterEach, expect, it, vi } from 'vitest';
import { languagesApi } from './languages';
afterEach(() => vi.unstubAllGlobals());
it('loads valid public language metadata with its direction and revision', async () => {
  const body = {source_locale:'en',languages:[{locale:'ar',name:'Arabic',native_name:'العربية',direction:'rtl',revision:1}]};
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  await expect(languagesApi.public()).resolves.toEqual(body);
});
it.each([[], {}, {source_locale:'en',languages:null}, {source_locale:'en',languages:[{locale:'ar'}]}])('rejects invalid public language metadata without passing it to UI consumers: %j', async body => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  await expect(languagesApi.public()).rejects.toThrow('invalid language metadata');
});
it('sends admin CSRF credentials and revisions without changing shared product fields', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({revision:2,status:'reviewed'})));
  vi.stubGlobal('fetch',fetch);
  const input = {expected_revision:1,source:{name:'Apple'},fields:{name:'تفاح'},reviewed:true};
  await languagesApi.saveTranslation('ar','product','product-id',input);
  expect(fetch).toHaveBeenCalledWith('/api/v1/admin/languages/ar/translations/product/product-id',expect.objectContaining({method:'PUT',credentials:'include',cache:'no-store',headers:{'content-type':'application/json','X-Commerce-Request':'1'},body:JSON.stringify(input)}));
});
it('encodes filters and exposes revision conflicts as actionable errors', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'conflict'}),{status:409}));
  vi.stubGlobal('fetch',fetch);
  await expect(languagesApi.translations('ar','category','Fruit & veg',50)).rejects.toMatchObject({status:409,message:expect.stringContaining('Reload the latest')});
  expect(fetch.mock.calls[0][0]).toBe('/api/v1/admin/languages/ar/translations?kind=category&q=Fruit+%26+veg&offset=50');
});
it('loads a single record directly for its selected locale and content type', async () => {
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({entity_id:'menu-id',source:{title:'Menu'},fields:{},revision:0,status:'missing'})));
  vi.stubGlobal('fetch',fetch);
  await languagesApi.translation('ar-EG','navigation','menu-id');
  expect(fetch).toHaveBeenCalledWith('/api/v1/admin/languages/ar-EG/translations/navigation/menu-id',expect.objectContaining({method:'GET',credentials:'include',cache:'no-store'}));
});

it.each([[], {}, { source_locale: 'en', languages: [{}] }])('rejects malformed language metadata instead of crashing the editor: %j', async payload => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
  await expect(languagesApi.list()).rejects.toThrow('invalid language metadata');
});
