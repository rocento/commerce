import { describe, expect, it, vi } from 'vitest';
import { AssistantLibrary, emptyPreference, parseHistory, validPreference, type MemoryView } from './assistantLibrary';
import { AssistantStore } from './assistantStore';
import { CommerceClient } from './commerce';
import fixture from '../testing/commerce-flow.json';

const id='80000000-0000-4000-8000-000000000001';
const turn={conversation_id:id,request_id:id,question:'Find a gift',answer:'A useful suggestion',created_at:'2026-10-13T00:00:00Z',blocks:[]};
const memory:MemoryView={enabled:true,guest:false,personalized:true,journey_consent:false,consent_version:3,expires_at:null,preferences:[],signals:[],categories:[{id,name:'Gifts'}],products:[]};
const setup=()=>{const client={memoryView:vi.fn(async()=>memory),assistantHistory:vi.fn(async()=>[turn]),savedGoals:vi.fn(async()=>[]),changeMemory:vi.fn(async()=>{}),exportMemory:vi.fn(async()=>({memory,contexts:[],consents:[]}))};return {client,library:new AssistantLibrary(client)};};
describe('saved conversations and memory',()=>{
  it('still loads saved history when memory is unavailable',async()=>{const {client,library}=setup();client.memoryView.mockRejectedValue(new Error('unavailable'));await expect(library.refresh(id,true)).rejects.toThrow();expect(library.conversations()).toHaveLength(1);expect(library.getSnapshot().memory).toBeNull();});
  it('groups and searches history, restores completed turns without replaying actions',async()=>{
    const {library}=setup();await library.refresh(id,true);expect(library.conversations('suggestion')[0]?.title).toBe('Find a gift');expect(library.conversations('absent')).toEqual([]);
    const streamAssistant=vi.fn(),chat=new AssistantStore({assistantID:()=>id,streamAssistant});
    await library.open(id,turns=>chat.restoreConversation(id,turns));expect(chat.conversationID).toBe(id);expect(chat.getSnapshot().turns[0]?.reply.completed).toBe(true);expect(chat.getSnapshot().turns[0]?.reply.checkoutRequested).toBe(false);expect(streamAssistant).not.toHaveBeenCalled();
    chat.setPersonalize(false);chat.reset();expect(chat.personalize).toBe(true);expect(chat.getSnapshot().turns).toEqual([]);
  });
  it('does not replace the current conversation when history is unavailable',async()=>{const {client,library}=setup();client.assistantHistory.mockResolvedValue([]);const accept=vi.fn();await expect(library.open(id,accept)).rejects.toThrow('no longer available');expect(accept).not.toHaveBeenCalled();});
  it('requires explicit readback after an unknown write outcome and preserves its draft',async()=>{
    const {client,library}=setup();await library.refresh(id,true);const draft={...emptyPreference(),attribute:'color',value:'blue',category_id:id};library.edit(draft);client.changeMemory.mockRejectedValueOnce(new Error('lost response'));
    const action={kind:'preference' as const,input:draft};await expect(library.mutate(action,id,true)).rejects.toThrow('lost response');await expect(library.mutate(action,id,true)).rejects.toThrow('Refresh');expect(client.changeMemory).toHaveBeenCalledTimes(1);expect(library.getSnapshot().draft).toEqual(draft);
    await library.refresh(id,true);await library.mutate(action,id,true);expect(client.changeMemory).toHaveBeenCalledTimes(2);expect(library.getSnapshot().draft).toEqual(emptyPreference());
  });
  it('clears private state and ignores a late export after account reset',async()=>{
    const {client,library}=setup();await library.refresh(id,true);await library.export();expect(library.getSnapshot().exported).toContain('consents');let finish!:(value:any)=>void;client.exportMemory.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));const pending=library.export();library.reset();finish({memory});await expect(pending).rejects.toThrow('previous session');expect(library.getSnapshot().exported).toBeNull();expect(library.getSnapshot().history).toEqual([]);expect(library.getSnapshot().memory).toBeNull();
  });
  it('rejects archived or missing goals on fresh read before loading their conversation',async()=>{const {client,library}=setup();await expect(library.resumeGoal(id,vi.fn())).rejects.toThrow('no longer active');expect(client.assistantHistory).not.toHaveBeenCalled();});
  it('validates stored turns and scoped preference values',()=>{
    expect(parseHistory([turn])).toHaveLength(1);expect(()=>parseHistory([turn,turn])).toThrow();expect(()=>parseHistory([{...turn,created_at:'invalid'}])).toThrow();expect(()=>parseHistory([{...turn,blocks:[{kind:'action',action:{route:'https://untrusted.test'}}]}])).toThrow();
    const input={...emptyPreference(),attribute:'color',value:'blue',category_id:id};expect(validPreference(input,memory)).toBe(true);expect(validPreference({...input,value:'x'.repeat(101)},memory)).toBe(false);expect(validPreference({...input,attribute:'product'},memory)).toBe(false);expect(validPreference(input,{...memory,personalized:false})).toBe(false);
  });
  it('keeps guest ownership in memory and sends personalization opt-out as a header only',async()=>{
    const cookie='g'.repeat(48),requests:{url:string;init:RequestInit}[]=[];
    const client=new CommerceClient(async(url,init)=>{requests.push({url,init});if(url.includes('/memory?'))return new Response(JSON.stringify({...memory,guest:true}),{headers:{'set-cookie':`assistant_guest=${cookie}; HttpOnly`}});return new Response(`data: ${JSON.stringify({version:'1',request_id:id,sequence:0,type:'done'})}\n\n`,{headers:{'content-type':'text/event-stream'}});},{get:async()=>null,set:async()=>{}},()=>id);
    await client.memoryView(id);await client.streamAssistant({request_id:id,conversation_id:id,message:'Gift',personalize:false},()=>{},new AbortController().signal);
    const request=requests[1]!.init;expect(new Headers(request.headers).get('cookie')).toBe(`assistant_guest=${cookie}`);expect(new Headers(request.headers).get('x-commerce-personalize')).toBe('0');expect(JSON.parse(request.body as string)).not.toHaveProperty('personalize');
  });
  it('fails closed when the guest ownership cookie cannot be retained',async()=>{const client=new CommerceClient(async()=>new Response(JSON.stringify({...memory,guest:true})),{get:async()=>null,set:async()=>{}},()=>id);await expect(client.memoryView(id)).rejects.toThrow('Guest memory session unavailable');});
  it('uses customer ownership, consent versions and goal versions on every control',async()=>{
    const requests:{url:string;init:RequestInit}[]=[];const client=new CommerceClient(async(url,init)=>{if(url.endsWith('/login'))return new Response(JSON.stringify({customer:fixture.customer,access_token:'fixture-token'}),{headers:{'set-cookie':`customer_refresh=${'f'.repeat(64)}; Secure`}});requests.push({url,init});return new Response('{}');},{get:async()=>null,set:async()=>{}},()=>id);
    await client.login('fixture','fixture');const goal={task_id:id,name:'Goal',archived:false,version:7,state:'draft',expires_at:'2099-01-01T00:00:00Z'};
    await client.changeMemory({kind:'consent',personalized:false,journey:true,version:3});await client.changeMemory({kind:'goal',goal,name:'Renamed',archived:true});await client.changeMemory({kind:'deleteGoal',goal});await client.changeMemory({kind:'clearContext',id});await client.changeMemory({kind:'removePreference',id});await client.changeMemory({kind:'delete'});await client.exportMemory();
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({personalized:false,journey:false,expected_version:3});expect(JSON.parse(requests[1]!.init.body as string)).toEqual({name:'Renamed',archived:true,expected_version:7});expect(requests[2]!.url).toContain('?version=7');expect(requests[2]!.init.method).toBe('DELETE');
    for(const r of requests){expect(new Headers(r.init.headers).get('authorization')).toBe('Bearer fixture-token');expect(new Headers(r.init.headers).get('cookie')).toBeNull();}
  });
});
