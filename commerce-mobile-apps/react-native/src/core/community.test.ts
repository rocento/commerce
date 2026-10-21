import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../shared/testing/commerce-flow.json';
import { ComparisonStore, comparisonRows, comparisonValue } from './comparison';
import { ReviewsStore, validReview, type Review } from './reviews';
import { CommerceClient } from './commerce';

const review: Review = { id:fixture.ids.history,display_name:'Mona',rating:4,title:'Fresh',body:'Good quality',status:'pending',version:1,created_at:'2026-10-13T00:00:00Z' };
describe('comparison',()=>{
  it('bounds selection, canonicalizes IDs, and clears after identity reset',()=>{
    const store=new ComparisonStore();for(let i=0;i<6;i++)store.toggle(`90000000-0000-4000-8000-00000000000${i}`);
    store.toggle('invalid');expect(store.getSnapshot().ids).toHaveLength(5);expect(store.prompt).toContain('/products/90000000');store.reset();expect(store.prompt).toBe('');
  });
  it('uses current prices and explicit missing, composite and currency values',()=>{
    expect(comparisonValue(false,'en')).toBe('No');expect(comparisonValue({value:1},'en')).toBe('Not provided');
    const rows=comparisonRows([{...fixture.product,attributes:{organic:true}},{...fixture.variant,currency:'USD',unit:'kg'}],'en');
    expect(rows[0]!.values).toEqual(['Choose options for pricing','25.00 USD']);expect(rows.at(-1)!.values).toEqual(['Yes','Not provided']);
  });
  it('rejects missing products and late responses after reset',async()=>{
    const store=new ComparisonStore();store.toggle(fixture.product.id);await store.load(async()=>{throw new Error('missing')});expect(store.getSnapshot().failed).toEqual([fixture.product.id]);
    await store.load(async()=>{store.reset();return fixture.product});expect(store.getSnapshot().products).toEqual([]);
  });
});
describe('reviews',()=>{
  function setup(){const api={reviews:vi.fn(async()=>[] as Review[]),ownReview:vi.fn(async()=>null as Review|null),submitReview:vi.fn(async()=>review)};return {api,store:new ReviewsStore(api)};}
  it('enforces UTF-8 bounds and verified submission before any write',async()=>{
    expect(validReview({...review,display_name:'ع'.repeat(41)})).toBe(false);expect(validReview({...review,body:'ع'.repeat(2001)})).toBe(false);
    const {api,store}=setup();await store.open(fixture.product.id,true);store.edit(review);await expect(store.submit(false)).rejects.toThrow();expect(api.submitReview).not.toHaveBeenCalled();
    await store.submit(true);expect(store.getSnapshot().own?.status).toBe('pending');expect(store.getSnapshot().submitted).toBe(true);
  });
  it('preserves drafts during paging and rejected refresh',async()=>{
    const {api,store}=setup();await store.open(fixture.product.id,true);store.edit(review);await store.load(true,50);
    expect(api.reviews).toHaveBeenLastCalledWith(fixture.product.id,50);expect(store.getSnapshot().draft.title).toBe('Fresh');
    api.reviews.mockRejectedValue(new Error('offline'));await expect(store.load(true,100)).rejects.toThrow();expect(store.getSnapshot().offset).toBe(50);expect(store.getSnapshot().draft.body).toBe('Good quality');
  });
  it('keeps submission success when refreshing the moderated list fails',async()=>{
    const {api,store}=setup();await store.open(fixture.product.id,true);store.edit(review);api.reviews.mockRejectedValue(new Error('offline'));
    await store.submit(true);expect(store.getSnapshot().submitted).toBe(true);expect(store.getSnapshot().uncertain).toBe(false);expect(store.getSnapshot().failed).toBe(true);
  });
  it('requires readback after an uncertain write and never automatically resubmits',async()=>{
    const {api,store}=setup();await store.open(fixture.product.id,true);store.edit(review);api.submitReview.mockRejectedValue(new Error('lost response'));
    await expect(store.submit(true)).rejects.toThrow();await expect(store.submit(true)).rejects.toThrow();expect(api.submitReview).toHaveBeenCalledTimes(1);
    api.ownReview.mockResolvedValue(review);await store.load(true);expect(store.getSnapshot().own?.status).toBe('pending');expect(store.getSnapshot().uncertain).toBe(false);
  });
  it('discards an old account response',async()=>{
    const {api,store}=setup();api.ownReview.mockImplementation(async()=>{store.reset();return review});await expect(store.open(fixture.product.id,true)).rejects.toThrow();expect(store.getSnapshot().own).toBeNull();
  });
  it('sends only review input fields with customer authorization',async()=>{
    const calls:{url:string;init:RequestInit}[]=[];
    const client=new CommerceClient(async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(url.includes('/auth/')?fixture.auth:review),{headers:{'set-cookie':`customer_refresh=${'r'.repeat(64)}; HttpOnly`}});},{get:async()=>null,set:async()=>{}},()=>fixture.ids.quote);
    await client.login('fixture','test');await client.submitReview(fixture.product.id,review);
    expect(calls[1]!.init.method).toBe('PUT');expect(JSON.parse(calls[1]!.init.body as string)).toEqual({display_name:'Mona',rating:4,title:'Fresh',body:'Good quality'});
    expect(new Headers(calls[1]!.init.headers).get('Authorization')).toBe(`Bearer ${fixture.auth.access_token}`);
  });
});
