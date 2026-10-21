import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
const c=await loadRuntime();
test('purpose requests ignore surrounding composer whitespace across catalogs',()=>{
 for(const purpose of ['face','picnic','layering','programming']){
  const text=`I need something for ${purpose}`;
  const expected=resolve(c,text);
  assert.equal(expected.status,'RESOLVED');
  for(const padding of ['\n','\n\n','\r\n',' \t\n']){
   const result=resolve(c,padding+text+padding);
   assert.equal(result.status,expected.status);
   assert.equal(result.intent,expected.intent);
   assert.deepEqual(result.entities,expected.entities);
  }
 }
});
test('purpose parsing still rejects embedded lines and additional actions',()=>{
 for(const text of ['I need something for\nface','I need something for face\nand checkout']){
  assert.equal(resolve(c,text).entities.catalogPurpose,undefined);
 }
});
test('purpose syntax is shared across product types and arbitrary merchant vocabulary',()=>{
 for(const [text,product,purpose,budget] of [
  ['Milk for breakfast under $5','milk','breakfast',5],
  ['A necklace for a wedding under $200','necklace','wedding',200],
  ['search for lanterns for stargazing under $30','lanterns','stargazing',30],
 ] as const){
  const r=resolve(c,text);assert.equal(r.status,'RESOLVED');assert.equal(r.intent,'PRODUCT_SEARCH');
  assert.equal(r.entities.productText,product);assert.equal(r.entities.catalogPurpose,purpose);
  assert.equal(r.entities.price.value,budget);assert.equal(r.entities.price.currency,'USD');
 }
});
test('purpose and budget refinements preserve independent constraints and replay',()=>{
 const first=resolve(c,'find milk for breakfast between $1 and $5');
 const next=resolve(c,'same budget, but for dessert',first.context.next);
 assert.equal(next.status,'RESOLVED');assert.equal(next.entities.catalogPurpose,'dessert');assert.equal(next.entities.productText,'milk');
 assert.deepEqual(next.entities.price,first.entities.price);
 const edited=resolve(c,'make it under $3',next.context.next);
 assert.equal(edited.status,'RESOLVED');assert.equal(edited.entities.catalogPurpose,'dessert');
 assert.match(edited.interpretationText!,/at least \$1/);assert.match(edited.interpretationText!,/under \$3/);
 assert.deepEqual(resolve(c,edited.interpretationText!).entities,edited.entities);
});
test('purpose does not swallow extra actions, exclusions, quotes or conditional requests',()=>{
 for(const text of ['find milk for breakfast and checkout','find milk for breakfast without nuts','find milk for breakfast if it is organic','add milk for breakfast to cart','find "Food for Thought"']){
  const r=resolve(c,text);if(r.entities.catalogPurpose){assert.equal(r.status,'NEEDS_CONTEXT');assert.ok(r.entities.requestConstraints?.length);}else assert.equal(r.entities.catalogPurpose,undefined,text);
 }
 const prior=resolve(c,'find milk under $5');
 for(const text of ['same budget, but for breakfast and buy it','same budget, but for dessert under $200']){
  assert.equal(resolve(c,text,prior.context.next).status,'NEEDS_CONTEXT');
 }
});


test('preparation wording is a catalog purpose, not a hardcoded cooking rule',()=>{
 for(const [verb,purpose] of [['cook','no cook'],['polish','no polish']]){
  const r=resolve(c,`Something I don't need to ${verb} under $5`);
  assert.equal(r.status,'RESOLVED');assert.equal(r.entities.catalogPurpose,purpose);
  const next=resolve(c,'make it under $3',r.context.next);
  assert.equal(next.status,'RESOLVED');assert.equal(next.entities.catalogPurpose,purpose);assert.equal(next.entities.price.value,3);
 }
});

test('whole-request recommendation reads do not invent a required today purpose',()=>{
 for(const text of ['Recommend a product for today','recommend products for today','please suggest something for today','recommend something today','show best sellers for today']){
  const r=resolve(c,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_RECOMMEND',text);
  assert.equal(r.entities.catalogPurpose,undefined,text);
 }
 for(const text of ['Milk for breakfast under $5','A necklace for anniversary under $200'])assert.ok(resolve(c,text).entities.catalogPurpose);
});
