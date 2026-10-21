import { afterEach, expect, it, vi } from 'vitest';
import { formatInterfaceMessage, interfaceTranslationsApi as api, type InterfaceBundle } from './interface-translations';
const bundle: InterfaceBundle={revision:1,catalog_version:'test',messages:[{key:'cart.item_count',group:'cart',plural:'count',en:{one:'{count} item',other:'{count} items'},ar:{zero:'لا توجد عناصر',one:'عنصر واحد',two:'عنصران',few:'{count} عناصر',many:'{count} عنصرًا',other:'{count} عنصر'}},{key:'cart.remove_item',group:'cart',plural:null,en:{other:'Remove {name}'},ar:{other:'إزالة {name}'}}],overrides:[]};
afterEach(()=>vi.unstubAllGlobals());
it('selects all six Arabic plural forms and both English forms',()=>{
  for(const [count,expected] of [[0,'لا توجد عناصر'],[1,'عنصر واحد'],[2,'عنصران'],[3,`${new Intl.NumberFormat('ar').format(3)} عناصر`],[11,`${new Intl.NumberFormat('ar').format(11)} عنصرًا`],[100,`${new Intl.NumberFormat('ar').format(100)} عنصر`]] as const) expect(formatInterfaceMessage(bundle,'cart.item_count','ar',{count})).toBe(expected);
  expect(formatInterfaceMessage(bundle,'cart.item_count','en',{count:1})).toBe('1 item');
  expect(formatInterfaceMessage(bundle,'cart.item_count','en',{count:2})).toBe('2 items');
  expect(()=>formatInterfaceMessage(bundle,'cart.item_count','ar',{count:NaN})).toThrow();
});
it('uses saved overrides and substitutes plain text without recursive interpretation',()=>{
  const custom={...bundle,overrides:[{key:'cart.remove_item',locale:'ar' as const,form:'other' as const,text:'حذف {name}',source_text:'إزالة {name}'}]};
  expect(formatInterfaceMessage(custom,'cart.remove_item','ar',{name:'<b>{name}</b>'})).toBe('حذف <b>{name}</b>');
  expect(()=>formatInterfaceMessage(custom,'cart.remove_item','ar')).toThrow('Missing placeholder');
  expect(()=>formatInterfaceMessage(bundle,'not.real','en')).toThrow('Unknown interface key');
});
it('binds an import to the reviewed revision and catalog version',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response('{"revision":2,"changed":1}'));
  vi.stubGlobal('fetch',fetch);
  await api.apply('key,en\ncart.add,Buy',{revision:1,catalog_version:'version-a',changes:[],errors:[]});
  expect(fetch).toHaveBeenCalledWith('/api/v1/admin/languages/interface/import',expect.objectContaining({method:'PUT',credentials:'include',headers:{'content-type':'application/json','X-Commerce-Request':'1'},body:JSON.stringify({csv:'key,en\ncart.add,Buy',expected_revision:1,catalog_version:'version-a'})}));
});
it('reports stale previews and non-JSON failures without hiding the HTTP status',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response('{"error":"conflict"}',{status:409})).mockResolvedValueOnce(new Response('too large',{status:413}));
  vi.stubGlobal('fetch',fetch);
  await expect(api.preview('key,en')).rejects.toMatchObject({status:409,message:expect.stringContaining('Reload and review')});
  await expect(api.preview('key,en')).rejects.toMatchObject({status:413});
});

it('loads saved storefront phrases from the public API without admin credentials or caches',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(bundle)));
  vi.stubGlobal('fetch',fetch);
  const signal=new AbortController().signal;
  await expect(api.public(signal)).resolves.toEqual(bundle);
  expect(fetch).toHaveBeenCalledWith('/api/v1/languages/interface',{cache:'no-store',signal});
});
