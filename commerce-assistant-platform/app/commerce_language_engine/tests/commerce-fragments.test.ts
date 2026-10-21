import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {commerceFragment,commerceReadFragments} from '../src/commerce-fragments.ts';
const c=await loadRuntime();
test('commerce noun fragments use explicit read actions with polite wording and stray punctuation',()=>{
 for(const entry of commerceReadFragments())for(const alias of entry.aliases)for(const prefix of ['','please ','pls '])for(const suffix of ['',' /','?','...']){
  const text=prefix+alias+suffix,r=resolve(c,text);
  assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,entry.intent,text);assert.equal(r.text,text);
 }
});
test('category fragments use catalog search across all supported industry vocabularies',()=>{
 const categories=new Map<string,Set<string>>();
 for(const e of c.dictionary.entity_terms.filter(e=>e.type==='CATEGORY')){const values=categories.get(e.alias)??new Set();values.add(e.value);categories.set(e.alias,values);}
 for(const [alias,values] of categories){
  if(values.size!==1||!/^[a-zA-Z][a-zA-Z\s-]*$/.test(alias))continue;
  if(commerceReadFragments().some(e=>(e.aliases as readonly string[]).includes(alias)))continue;
  for(const suffix of ['',' /','?']){
   const r=resolve(c,alias+suffix);
   const explicit=resolve(c,'find '+alias);
   if(explicit.status==='RESOLVED'){assert.equal(r.intent,'PRODUCT_SEARCH',alias);assert.equal(r.status,'RESOLVED',alias);assert.equal(r.entities.productText,alias);}
   else assert.notEqual(r.status,'RESOLVED',alias+' must retain ambiguity');
  }
 }
});
test('no fragment inference for negation, multiple clauses, numeric values, or arbitrary product identities',()=>{
 for(const text of ['do not show cart','cart / empty it','coffee and add it','cancel orders','place order','red','XL','2','10 USD','tomorrow','SAVE20','SKU-123','"coffee"','coffee; checkout','my address','first'])assert.equal(commerceFragment(c.dictionary,text),undefined,text);
});
