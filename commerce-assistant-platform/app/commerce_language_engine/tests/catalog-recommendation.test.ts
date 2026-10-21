import './recognition-test-context.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {catalog} from '../src/catalog.ts';
import {extract} from '../src/entities.ts';
import {industryTerms} from '../src/generation/industry-terms.ts';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';

const aliases=[...catalog.flatMap(item=>item.aliases.map(alias=>({
  type:'CATEGORY',value:item.category,alias,industry:item.industry,
}))),...industryTerms];

test('dates recommendations resolve with polite prefixes and optional item wording',async()=>{
  const runtime=await loadRuntime();
  for(const text of ['pls recommend dates','pls recommend dates item','please recommend dates','recommend dates']) {
    const result=resolve(runtime,text);
    assert.equal(result.status,'RESOLVED',text);
    assert.equal(result.intent,'PRODUCT_RECOMMEND',text);
    assert.equal(result.entities.category,'dates',text);
    assert.ok(result.confidence>=0.65,text);
  }
});

test('category-only recommendation phrases resolve to catalog categories',()=>{
  for(const [text,category] of [
    ['recommend fruits','fruit'],
    ['recommend dates','dates'],
    ['recommend breakfast cereal','cereal'],
    ['recommend fish','seafood'],
    ['recommend bananas','banana'],
  ]) {
    assert.equal(extract(text,aliases).category,category,text);
  }
});

test('recommendations retain names and support explicit merchant filters',async()=>{
 const runtime=await loadRuntime();
 for(const [text,expected] of [
  ['recommend Lipton green tea',{productText:'lipton green tea'}],
  ['recommend products in Bakery',{productText:'*',category:'bakery'}],
  ['recommend products in category Bakery',{productText:'*',category:'bakery'}],
  ['recommend products in category beverages',{productText:'*',category:'beverages'}],
  ['recommend products with color burgundy',{productText:'*',color:'burgundy'}],
  ['recommend products with material linen',{productText:'*',material:'linen'}],
  ['recommend products with flavor vanilla',{productText:'*',flavor:'vanilla'}],
 ] as const){
  const result=resolve(runtime,text);
  assert.equal(result.status,'RESOLVED',text);
  assert.equal(result.intent,'PRODUCT_RECOMMEND',text);
  for(const [key,value] of Object.entries(expected))assert.equal(result.entities[key],value,text);
 }
});

test('explicit filters never swallow additional requirements',async()=>{
 const runtime=await loadRuntime();
 for(const text of ['recommend products with color red and size large','recommend products with color red under $20','recommend products in category tea without sugar']){
  const result=resolve(runtime,text);
  assert.notEqual(result.entities.productText,'*',text);
 }
});

test('open-ended recommendations browse the catalog without dropping constraints',async()=>{
 const runtime=await loadRuntime();
 for(const text of ['pls recommend something','please recommend something','recommend me something','could you recommend something please?','suggest something','recommend some products','recommend anything today']){
  const result=resolve(runtime,text);
  assert.equal(result.status,'RESOLVED',text);
  assert.equal(result.intent,'PRODUCT_RECOMMEND',text);
  assert.equal(result.entities.productText,'*',text);
  assert.equal(result.entities.salesPeriod,undefined,text);
 }
 for(const text of ['recommend something under $20','recommend something without sugar','recommend something and add it to cart','do not recommend something','recommend Something Special tea']){
  const result=resolve(runtime,text);
  assert.notEqual(result.entities.productText,'*',text);
 }
});

test('bounded discovery followups retain their mode',async()=>{
 const runtime=await loadRuntime();
 for(const [text,mode] of [['something else','different'],['pls recommend something else','different'],['show me cheaper options','cheaper'],['something cheaper','cheaper']]){
  const result=resolve(runtime,text);
  assert.equal(result.intent,'PRODUCT_RECOMMEND',text);
  assert.equal(result.entities.recommendationFollowup,mode,text);
 }
 for(const text of ['something else without sugar','cheaper options and add to cart'])assert.equal(resolve(runtime,text).entities.recommendationFollowup,undefined,text);
});
