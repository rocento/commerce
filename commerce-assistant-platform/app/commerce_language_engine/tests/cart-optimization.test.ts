import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildKnowledge} from '../src/knowledge.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';

for(const [name,build] of [['core',buildKnowledge],['expanded',buildExpandedDictionary]] as const){
 const compiled=compile(build());
 test(`${name}: cart optimization understands budget requests and controlled typos`,()=>{
  for(const text of ['pls optmize my cart to be less than 50 usd','please optimize my cart to be less than $50','optimise my basket to be less than 50 USD','pls optmize my cart to be less than 50 usd &#x20;']){
   const r=resolve(compiled,text);
   assert.equal(r.status,'RESOLVED',text);
   assert.equal(r.intent,'OPTIMIZE_CART',text);
   assert.deepEqual(r.entities.price,{operator:'<',value:50,currency:'USD'});
   assert.equal(r.requiresConfirmation,true);
   if(text.includes('optmize'))assert.ok(r.debug.matchedPhrases.some(m=>m.phrase==='optmize'&&m.fuzzy));
  }
  assert.deepEqual(resolve(compiled,'optimize my cart to be at most 50 usd').entities.price,{operator:'<=',value:50,currency:'USD'});
 });
 test(`${name}: optimization requires a cart and an affirmative action`,()=>{
  for(const text of ['do not optimize my cart to be less than 50 usd','never optmize my basket','optimize my website','my cart is less than 50 usd','less than 50 usd']){
   assert.equal(resolve(compiled,text).status,'UNKNOWN',text);
  }
 });
}
