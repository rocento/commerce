import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseInterfacePreview, receiveInterfacePreview } from './interface-preview';
const bundle={revision:1,catalog_version:'v1',messages:[{key:'cart.title',group:'cart',plural:null,en:{other:'Your cart'},ar:{other:'سلتك'}}],overrides:[]};
let frame: EventTarget & {parent:{postMessage:ReturnType<typeof vi.fn>};setTimeout:typeof setTimeout};
const origin='https://admin.example.test';
beforeEach(()=>{vi.useFakeTimers();frame=Object.assign(new EventTarget(),{parent:{postMessage:vi.fn()},setTimeout});vi.stubGlobal('window',frame);});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function send(patch:Record<string,unknown>={}){frame.dispatchEvent(Object.assign(new Event('message'),{origin,source:frame.parent,data:{type:'rocento:interface-preview-bundle',channel:'nonce',bundle},...patch}));}
it('accepts only the paired parent, origin and channel',async()=>{
 let received=false;const pending=receiveInterfacePreview(origin,'nonce',new AbortController().signal).then(v=>{received=true;return v;});
 expect(frame.parent.postMessage).toHaveBeenCalledWith({type:'rocento:interface-preview-ready',channel:'nonce'},origin);
 send({origin:'https://other.test'});send({source:{}});send({data:{type:'rocento:interface-preview-bundle',channel:'wrong',bundle}});
 await Promise.resolve();expect(received).toBe(false);send();await expect(pending).resolves.toEqual(bundle);expect(vi.getTimerCount()).toBe(0);
});
it('rejects top-level previews and invalid origins',async()=>{
 await expect(receiveInterfacePreview('javascript:alert(1)','nonce',new AbortController().signal)).rejects.toThrow('Invalid');
 Object.assign(frame,{parent:frame});await expect(receiveInterfacePreview(origin,'nonce',new AbortController().signal)).rejects.toThrow('admin');
});
it('cleans up on timeout and cancellation',async()=>{
 const result=receiveInterfacePreview(origin,'nonce',new AbortController().signal);const check=expect(result).rejects.toThrow('did not respond');await vi.advanceTimersByTimeAsync(15000);await check;
 const controller=new AbortController();const pending=receiveInterfacePreview(origin,'nonce',controller.signal);controller.abort();await expect(pending).rejects.toThrow('cancelled');expect(vi.getTimerCount()).toBe(0);
});
it('rejects malformed bundles and ignores stale or incompatible overrides',()=>{
 expect(()=>parseInterfacePreview({...bundle,messages:[...bundle.messages,...bundle.messages]})).toThrow();
 expect(()=>parseInterfacePreview({...bundle,messages:[{...bundle.messages[0],ar:{other:{html:'bad'}}}]})).toThrow();
 const override={key:'cart.title',locale:'ar',form:'other',text:'سلة التسوق',source_text:'سلتك'};
 expect(parseInterfacePreview({...bundle,overrides:[override]}).overrides).toHaveLength(1);
 expect(parseInterfacePreview({...bundle,overrides:[{...override,source_text:'old'},{...override,text:'{unexpected}'}]}).overrides).toEqual([]);
});

it('the shipped registry is accepted and every wired key exists',()=>{
 const registry=JSON.parse(readFileSync(new URL('../../../../commerce-api/interface-messages.json',import.meta.url),'utf8'));
 const parsed=parseInterfacePreview({...bundle,messages:registry.messages.map((m:Record<string,unknown>)=>({plural:null,...m}))});
 const keys=new Set(parsed.messages.map(m=>m.key));
 for(const file of ['main','cart','checkout','checkout-loading','catalog','search','locations','fulfillment-options','delivery-slots','price-filter','product-price','themes','product-types','map-pin','city-select','community','comparison','notifications','orders','support','content','public/page','public/merchant','public/search']){
  const source=readFileSync(new URL(`./${file}.tsx`,import.meta.url),'utf8');
  for(const match of source.matchAll(/ui\(["']([^"']+)["']/g))expect(keys.has(match[1]),`${file}: ${match[1]}`).toBe(true);
 }
});
