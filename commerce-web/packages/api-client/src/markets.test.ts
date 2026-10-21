import { afterEach, expect, it, vi } from 'vitest';
import { marketsApi } from './markets';
afterEach(()=>vi.unstubAllGlobals());
it('keeps exact price strings, inheritance and revision in scoped saves',async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({revision:2})));vi.stubGlobal('fetch',fetch);
 const input={available:null,price:'9999999999.99',currency:'SAR',expected_revision:1};
 await marketsApi.saveEntity('market','product','product',input);
 expect(fetch).toHaveBeenCalledWith('/api/v1/admin/markets/market/product/product',expect.objectContaining({method:'PUT',credentials:'include',cache:'no-store',headers:{'content-type':'application/json','X-Commerce-Request':'1'},body:JSON.stringify(input)}));
});
it('surfaces stale market edits as conflicts',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'conflict'}),{status:409})));
 await expect(marketsApi.saveEntity('market','category','category',{available:false,price:null,currency:'EGP',expected_revision:1})).rejects.toMatchObject({status:409,message:expect.stringContaining('Reload before saving')});
});

it.each([[], {}, { items: [], locales: [] }])('rejects malformed market metadata: %j', async payload => {
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
 await expect(marketsApi.list()).rejects.toThrow('invalid market metadata');
});

 it('preserves the source locale independently of alphabetically sorted market languages', async () => {
  const payload = {items:[],locales:['ar','en'],source_locale:'en',live:{region:'EG',currency:'EGP'},activation_available:true};
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
  expect(await marketsApi.list()).toEqual(payload);
 });
