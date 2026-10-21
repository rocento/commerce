import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {canonicalRead} from '../src/read-language.ts';
import {searchCommandCorrections} from '../src/search-language.ts';
const c=await loadRuntime();
test('service questions resolve existing read intents',()=>{
 for(const [text,intent] of [
  ['What payment methods do you accept?','PAYMENT_METHODS'],['How can I pay?','PAYMENT_METHODS'],
  ['Can I pay cash on delivery?','PAYMENT_CASH_ON_DELIVERY'],['Do you accept cash on delivery?','PAYMENT_CASH_ON_DELIVERY'],
  ['When can you deliver?','DELIVERY_TIME'],['How long does delivery take?','DELIVERY_TIME'],
  ['Can I collect in store?','FIND_PICKUP_LOCATION'],['Where can I collect my order?','FIND_PICKUP_LOCATION'],
 ]){
  for(const phrase of [text,'Please '+text.toLowerCase()]){
   const r=resolve(c,phrase);assert.equal(r.status,'RESOLVED',phrase);assert.equal(r.intent,intent,phrase);
  }
  for(const unsafe of ['do not '+text,text+' and checkout',text+' if it is free','"'+text+'"'])assert.equal(canonicalRead(unsafe),undefined,unsafe);
 }
});
test('purpose wrappers preserve merchant vocabulary and budget across product domains',()=>{
 for(const [purpose,budget] of [['breakfast',5],['anniversary',200],['stargazing',30]] as const){
  for(const wrapper of ['I need','I want','We need','Please we want']){
   const r=resolve(c,`${wrapper} something for ${purpose} under $${budget}`);
   assert.equal(r.status,'RESOLVED');assert.equal(r.intent,'PRODUCT_SEARCH');
   assert.equal(r.entities.catalogPurpose,purpose);assert.equal(r.entities.price.value,budget);
   const next=resolve(c,'make it under $3',r.context.next);
   assert.equal(next.entities.catalogPurpose,purpose);assert.equal(next.entities.price.value,3);
  }
 }
 for(const text of ['I do not need something for breakfast','I need something for breakfast and buy it','I want something for an anniversary without gold']){
  const r=resolve(c,text);assert.ok(r.status!=='RESOLVED'||r.entities.requestConstraints?.length,text);
 }
});
test('recommendation typos correct only leading commands and preserve constraints',()=>{
 for(const product of ['milk','necklace'])for(const typo of ['recomend','recommed','sugest']){
  const r=resolve(c,`pls ${typo} ${product} under $5`);
  assert.equal(r.status,'RESOLVED');assert.equal(r.intent,'PRODUCT_RECOMMEND');assert.equal(r.entities.productText,product);assert.equal(r.entities.price.value,5);
  const denied=resolve(c,`do not ${typo} ${product}`);assert.notEqual(denied.status,'RESOLVED');
 }
 for(const text of ['find recomend necklace','find "sugest"','find SKU-recomend','find milk then recomend necklace'])assert.deepEqual(searchCommandCorrections(text),[]);
 const r=resolve(c,'pls recomend necklace for anniversary under $200');
 assert.equal(r.entities.catalogPurpose,'anniversary');assert.equal(r.entities.productText,'necklace');assert.equal(r.entities.price.value,200);
});
