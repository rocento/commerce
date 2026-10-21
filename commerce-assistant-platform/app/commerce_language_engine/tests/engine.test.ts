import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildKnowledge} from '../src/knowledge.ts';
import {resolve} from '../src/engine.ts';
const compiled=compile(buildKnowledge());
test('search extracts reusable category, brand, color, size and price',()=>{
 const r=resolve(compiled,'show me black Adidas running shoes under $150 size 43');assert.equal(r.status,'RESOLVED');assert.equal(r.intent,'PRODUCT_SEARCH');assert.deepEqual(r.entities,{category:'running_shoes',brand:'Adidas',color:'black',price:{operator:'<',value:150,currency:'USD'},size:'43',productText:'black adidas running shoes'});
});
test('unknown and weak language cannot resolve an order action',()=>{for(const text of ['','order','cancel','purple elephants','write a poem about shoes'])assert.equal(resolve(compiled,text).status,'UNKNOWN',text);});
test('negated cancellation does not beat tracking',()=>{const r=resolve(compiled,"don't cancel the order, just show me where it is");assert.equal(r.status,'AMBIGUOUS');assert.ok(r.debug.candidates.slice(0,2).some(c=>c.intent==='TRACK_ORDER'));assert.notEqual(r.intent,'CANCEL_ORDER');assert.ok(r.negativeEvidence.some(e=>e.kind==='NEGATED'));});
test('conflicting positive actions abstain',()=>{for(const text of ['cancel and create order','add and remove shoes from cart']){const r=resolve(compiled,text);assert.equal(r.status,'AMBIGUOUS');assert.equal(r.intent,null);}});
test('session selection then contextual quantity',()=>{const a=resolve(compiled,'find running shoes');const b=resolve(compiled,'the second one',a.context.next);const c=resolve(compiled,'add two',b.context.next);assert.equal(b.intent,'SELECT_PRODUCT');assert.equal(c.intent,'ADD_TO_CART');assert.equal(c.entities.quantity,2);assert.equal(resolve(compiled,'add two').status,'UNKNOWN');});
test('order repeat and cart removal use context',()=>{assert.equal(resolve(compiled,'do it again',{previousIntent:'ORDER_HISTORY',states:['ORDER_LIST_VISIBLE']}).intent,'REORDER');assert.equal(resolve(compiled,'remove the first one',{previousIntent:'VIEW_CART',states:['CART_NON_EMPTY']}).intent,'REMOVE_FROM_CART');assert.notEqual(resolve(compiled,'the first one',{previousIntent:'VIEW_CART',states:['CART_NON_EMPTY']}).intent,'REMOVE_FROM_CART');});
test('controlled typo correction remains explainable',()=>{const r=resolve(compiled,'wheres mi ordar');assert.equal(r.intent,'TRACK_ORDER');assert.ok(r.debug.matchedPhrases.some(m=>m.fuzzy));});
test('compiler rejects broken group references',()=>{const d=buildKnowledge();d.intents[0].conditions[0].group='MISSING';assert.throws(()=>compile(d),/Unreachable/);});
test('required occurrences and disqualifiers change candidate eligibility',()=>{const d=buildKnowledge();d.intents.find(i=>i.code==='CREATE_ORDER')!.conditions.push({group:'REFERENCE_IT',kind:'DISQUALIFY',score:0});const r=resolve(compile(d),'create this order');assert.notEqual(r.intent,'CREATE_ORDER');});

test('explicit recommendation categories own action-like names and keep budgets',()=>{
 for(const category of ['New Arrivals','Gifts','Bakery']){
  const plain=resolve(compiled,`Recommend products in category ${category}`);
  assert.equal(plain.status,'RESOLVED');assert.equal(plain.intent,'PRODUCT_RECOMMEND');
  assert.equal(plain.entities.category,category.toLowerCase());
  const budget=resolve(compiled,`Recommend products in category ${category} under 200 EGP`);
  assert.equal(budget.status,'RESOLVED');assert.equal(budget.intent,'PRODUCT_RECOMMEND');
  assert.ok(budget.entities.productText.includes(category.toLowerCase()));
  assert.deepEqual(budget.entities.price,{operator:'<',value:200,currency:'EGP'});
 }
 const compound=resolve(compiled,'Recommend products in category New Arrivals and add shoes to cart');
 assert.notEqual(compound.status,'RESOLVED');
});
