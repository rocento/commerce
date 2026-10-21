import { describe, expect, it, vi } from 'vitest';
import { CommerceClient, CommerceError } from './commerce';
import { SupportStore, validSupport, type SupportDetail } from './support';
import fixture from '../../../shared/testing/commerce-flow.json';

const id=fixture.ids.order;
const detail:SupportDetail={ticket:{id,number:42,subject:'Delivery',category:'order_issue',status:'open',priority:'normal',order_id:id,created_at:'2026-10-13T00:00:00Z'},messages:[{id:fixture.ids.history,sender:'customer',body:'Where is it?',created_at:'2026-10-13T00:00:00Z'}]};
const draft={subject:'Delivery',category:'order_issue',body:'Where is it?',order_id:id};
function setup(){const api={supportTickets:vi.fn(async()=>[detail.ticket]),supportDetail:vi.fn(async()=>detail),createSupport:vi.fn(async()=>detail),replySupport:vi.fn(async()=>detail)};return{api,store:new SupportStore(api,()=>fixture.ids.quote)};}
describe('support lifecycle',()=>{
  it('freezes and explicitly retries the same create request after a lost response',async()=>{
    const {api,store}=setup();store.compose(id);store.edit(draft);api.createSupport.mockRejectedValueOnce(new Error('lost'));
    await expect(store.create(true)).rejects.toThrow();const attempt=store.getSnapshot().attempt;store.edit({...draft,body:'different'});store.showList();await store.refresh();store.compose();
    expect(store.getSnapshot().draft.body).toBe(draft.body);expect(api.createSupport).toHaveBeenCalledTimes(1);await store.create(true);
    expect(api.createSupport.mock.calls[1]).toEqual([attempt]);expect(store.getSnapshot().created).toBe(true);expect(store.getSnapshot().attempt).toBeNull();
  });
  it('retains per-ticket reply drafts, locks uncertain replies and deduplicates explicit retry',async()=>{
    const {api,store}=setup();await store.open(id);store.editReply('Please check');api.replySupport.mockRejectedValueOnce(new Error('lost'));
    await expect(store.sendReply()).rejects.toThrow();store.editReply('changed');await store.open(fixture.product.id);store.editReply('another');await expect(store.sendReply()).rejects.toThrow();
    await store.open(id);expect(store.getSnapshot().reply).toBe('Please check');await store.sendReply();expect(api.replySupport.mock.calls[0]).toEqual(api.replySupport.mock.calls[1]);expect(store.getSnapshot().replied).toBe(true);
  });
  it('unlocks validation failures, rejects UTF-8 overflow and clears customer state',async()=>{
    expect(validSupport({...draft,body:'ع'.repeat(1001)},true)).toBe(false);expect(validSupport(draft,false)).toBe(false);
    const {api,store}=setup();store.edit(draft);api.createSupport.mockRejectedValueOnce(new CommerceError(422,'invalid'));await expect(store.create(true)).rejects.toThrow();expect(store.getSnapshot().attempt).toBeNull();
    api.supportDetail.mockImplementation(async()=>{store.reset();return detail});await expect(store.open(id)).rejects.toThrow();expect(store.getSnapshot().detail).toBeNull();expect(store.getSnapshot().tickets).toEqual([]);
  });
  it('preserves draft on refresh failures and never posts on refresh',async()=>{
    const {api,store}=setup();store.edit(draft);api.supportTickets.mockRejectedValue(new Error('offline'));await expect(store.refresh()).rejects.toThrow();expect(store.getSnapshot().draft).toEqual(draft);expect(api.createSupport).not.toHaveBeenCalled();
  });
  it('initializes guest cookie once and reuses it without leaking customer credentials',async()=>{
    const calls:{url:string;init:RequestInit}[]=[];let writes=0;
    const client=new CommerceClient(async(url,init)=>{calls.push({url,init});if(url.endsWith('/session')){const response=new Response('{"status":"ok"}');Object.defineProperty(response,'headers',{value:{get:()=>`support_guest=${'g'.repeat(48)}; HttpOnly`}});return response;}if(++writes===1)throw new Error('lost');return new Response(JSON.stringify(detail));},{get:async()=>null,set:async()=>{}},()=>fixture.ids.quote);
    const store=new SupportStore(client,()=>fixture.ids.quote);store.edit({...draft,order_id:undefined,contact_name:'Mona',contact:'mona@example.test'});await expect(store.create(false)).rejects.toThrow();await store.create(false);
    expect(calls).toHaveLength(3);expect(calls[1]!.init.body).toBe(calls[2]!.init.body);expect(new Headers(calls[1]!.init.headers).get('Cookie')).toBe(`support_guest=${'g'.repeat(48)}`);expect(new Headers(calls[1]!.init.headers).get('Authorization')).toBeNull();
  });
  it('uses authenticated customer endpoints and excludes administrative reply status',async()=>{
    const calls:{url:string;init:RequestInit}[]=[];
    const client=new CommerceClient(async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(url.includes('/auth/')?fixture.auth:url.endsWith('/tickets')&&init.method==='GET'?[detail.ticket]:detail),{headers:{'set-cookie':`customer_refresh=${'r'.repeat(64)}; HttpOnly`}});},{get:async()=>null,set:async()=>{}},()=>fixture.ids.quote);
    await client.login('fixture','test');await client.supportTickets();await client.supportDetail(id);await client.createSupport({...draft,request_id:fixture.ids.quote});await client.replySupport(id,fixture.ids.quote,'Please check');
    expect(calls.some(c=>c.url.endsWith('/session'))).toBe(false);expect(JSON.parse(calls.at(-1)!.init.body as string)).toEqual({request_id:fixture.ids.quote,body:'Please check'});expect(new Headers(calls.at(-1)!.init.headers).get('Authorization')).toBe(`Bearer ${fixture.auth.access_token}`);
  });
});
