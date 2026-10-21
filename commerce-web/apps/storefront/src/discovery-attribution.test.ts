import { afterEach,describe,it,expect,vi } from 'vitest';
vi.mock('@commerce/api-client',()=>({customerSessionHeaders:()=>({})}));
import {configureDiscoveryAttribution,discoveryEvidence,discoverySession,redirectEvidence,trackDiscovery} from './discovery-attribution';
afterEach(()=>{configureDiscoveryAttribution(false);vi.unstubAllGlobals();});
describe('discovery browser privacy and shared session',()=>{
 it('retains only allowed campaign tokens and referrer origin',()=>{
  expect(discoveryEvidence('https://shop.test/products/a?utm_source=chatgpt.com&utm_campaign=spring&token=SECRET','https://chatgpt.com/c/private-conversation?token=SECRET')).toEqual({referrer:'https://chatgpt.com',source:'chatgpt.com',medium:'',campaign:'spring'});
  expect(discoveryEvidence('https://shop.test/?utm_source=one&utm_source=two&utm_campaign=user%40example.com','javascript:SECRET')).toEqual({referrer:'invalid',source:'__invalid__',medium:'',campaign:'__invalid__'});
 });
 it('consumes only allowlisted redirect evidence',()=>{expect(redirectEvidence('discovery-entry='+encodeURIComponent(JSON.stringify({source:'chatgpt.com',medium:'',campaign:'spring',referrer:'https://chatgpt.com/private?secret=PRIVATE',token:'SECRET'})))).toEqual({source:'chatgpt.com',medium:'',campaign:'spring',referrer:'https://chatgpt.com'});expect(redirectEvidence('discovery-entry=broken')).toBeNull();});
 it('shares the legacy UUID and rotates after 30 minutes idle',()=>{
  const values=new Map<string,string>();vi.stubGlobal('sessionStorage',{getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});
  const first=discoverySession(1000);expect(discoverySession(2000)).toBe(first);expect(discoverySession(31*60000+2000)).not.toBe(first);vi.unstubAllGlobals();
 });
});
describe('installation attribution capability',()=>{
 function browser(){
  const values=new Map<string,string>();
  const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:204}));
  vi.stubGlobal('fetch',fetcher);
  vi.stubGlobal('navigator',{doNotTrack:'0'});
  vi.stubGlobal('document',{cookie:'',referrer:''});
  vi.stubGlobal('location',new URL('https://shop.test/'));
  vi.stubGlobal('sessionStorage',{getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});
  return {fetcher,values};
 }
 it('does not send attribution until the installation explicitly permits it',()=>{
  const {fetcher,values}=browser();
  trackDiscovery('/','visit');
  configureDiscoveryAttribution(false);trackDiscovery('/','visit');
  expect(fetcher).not.toHaveBeenCalled();expect(values.size).toBe(0);
 });
 it('preserves allowed page-view evidence and stops when capability is disabled',()=>{
  const {fetcher}=browser();configureDiscoveryAttribution(true);
  trackDiscovery('/','visit');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/discovery/attribution');
  const init=fetcher.mock.calls[0][1] as RequestInit;
  expect(init.credentials).toBe('include');
  expect(JSON.parse(String(init.body))).toMatchObject({id:'visit',path:'/',evidence:{referrer:'',source:'',medium:'',campaign:''}});
  configureDiscoveryAttribution(false);trackDiscovery('/','second');
  expect(fetcher).toHaveBeenCalledOnce();
 });
 it.each([{doNotTrack:'1'},{globalPrivacyControl:true}])('honors browser privacy even when the installation permits attribution',privacy=>{
  const {fetcher}=browser();configureDiscoveryAttribution(true);vi.stubGlobal('navigator',privacy);
  trackDiscovery('/','visit');expect(fetcher).not.toHaveBeenCalled();
 });
});
