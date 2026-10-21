import { afterEach,beforeEach,expect,it,vi } from 'vitest';

const transport=vi.hoisted(()=>vi.fn());
vi.mock('./telemetry',()=>({traceFetch:transport}));
const NativeRequest=Request;
beforeEach(()=>{
  vi.resetModules();transport.mockReset();
  // Browsers resolve the API client's relative URL against the document origin.
  vi.stubGlobal('Request',class extends NativeRequest {
    constructor(input:RequestInfo|URL,init?:RequestInit){super(typeof input==='string'?new URL(input,'https://shop.test/'):input,init);}
  });
});
afterEach(()=>vi.unstubAllGlobals());
const customer={id:'customer-a'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

it('maps the normal guest session response to the existing signed-out state without credentials',async()=>{
  transport.mockResolvedValue(new Response(null,{status:204}));
  const {customerApi,customerSessionHeaders}=await import('./identity');
  await expect(customerApi.restore()).rejects.toMatchObject({message:'Signed out',status:401});
  expect(customerSessionHeaders()).not.toHaveProperty('Authorization');
  expect(transport).toHaveBeenCalledOnce();
});
it('restores and shares one authenticated session request across simultaneous callers',async()=>{
  transport.mockResolvedValue(json({customer,access_token:'valid-access'}));
  const {customerApi,customerSessionHeaders}=await import('./identity');
  await expect(Promise.all([customerApi.restore(),customerApi.restore()])).resolves.toEqual([customer,customer]);
  expect(transport).toHaveBeenCalledOnce();
  expect(customerSessionHeaders()).toHaveProperty('Authorization','Bearer valid-access');
});
it('removes an earlier in-memory access token when the refresh cookie is absent',async()=>{
  transport.mockResolvedValueOnce(json({customer,access_token:'old-access'})).mockResolvedValueOnce(new Response(null,{status:204}));
  const {customerApi,customerSessionHeaders}=await import('./identity');
  await customerApi.restore();
  await expect(customerApi.restore()).rejects.toMatchObject({status:401});
  expect(customerSessionHeaders()).not.toHaveProperty('Authorization');
});
it.each([401,403,503])('retains actual refresh HTTP failure %s',async status=>{
  transport.mockResolvedValue(json({error:'Session rejected'},status));
  const {customerApi}=await import('./identity');
  await expect(customerApi.restore()).rejects.toMatchObject({message:'Session rejected',status});
});
it('does not replay a protected request after the server confirms there is no refresh session',async()=>{
  transport.mockResolvedValueOnce(json({error:'Unauthorized'},401)).mockResolvedValueOnce(new Response(null,{status:204}));
  const {customerApi}=await import('./identity');
  await expect(customerApi.me()).rejects.toMatchObject({status:401});
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls.map(([request])=>new URL((request as Request).url).pathname)).toEqual(['/api/v1/customer/me','/api/v1/customer/auth/refresh']);
});
