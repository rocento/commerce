import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {validContext} from '../src/context.ts';
import {requestConstraints} from '../src/request-constraints.ts';

for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: conditions retain the action and distinguish monetary scope`,()=>{
  for(const [text,intent,scope] of [
   ['checkout only if delivery is free','START_CHECKOUT','DELIVERY'],
   ['add two bottles of milk to my cart only if the total stays under $10','ADD_TO_CART','BASKET_TOTAL'],
   ['add two mugs to cart if the line total is under $8','ADD_TO_CART','LINE_TOTAL'],
   ['add milk to cart if the product price is under $4','ADD_TO_CART','UNIT_PRICE'],
   ['if shipping is free, start checkout','START_CHECKOUT','DELIVERY'],
  ]){
   const r=resolve(c,text);
   assert.equal(r.status,'NEEDS_CONTEXT',text);assert.equal(r.intent,intent,text);
   assert.equal(r.confidence,0);assert.equal(r.entities.price,undefined);
   const constraint=r.entities.requestConstraints[0];assert.equal(constraint.scope,scope);
   assert.equal([...text].slice(constraint.start,constraint.end).join(''),constraint.text);
   assert.ok(r.graph?.nodes.some(n=>n.kind==='CONDITION'));
   assert.equal(r.fulfillment?.status,'NOT_EXECUTED');assert.ok(r.missing?.includes('requestConstraints'));
  }
 });
 test(`${name}: exclusions and ranges preserve one product without false quantities`,()=>{
  const text='find shoes between $50 and $100 excluding Nike';
  const r=resolve(c,text);assert.equal(r.status,'NEEDS_CONTEXT');
  assert.equal(r.entities.productText,'shoes');assert.equal(r.entities.brand,undefined);
  assert.equal(r.entities.quantity,undefined);assert.ok((r.entities.items?.length??1)<=1);
  assert.deepEqual(r.entities.price,{operator:'BETWEEN',min:50,max:100,currency:'USD'});
  assert.equal(r.entities.requestConstraints[0].value,'Nike');
  assert.equal(resolve(c,'find shoes between $50 and $100').status,'RESOLVED');
 });
 test(`${name}: search edits replace only named fields across three turns`,()=>{
  const first=resolve(c,'find black running shoes under $100');
  const second=resolve(c,'actually blue, and make the budget $80',first.context.next);
  assert.equal(second.status,'RESOLVED');assert.equal(second.intent,'PRODUCT_SEARCH');
  assert.equal(second.entities.color,'blue');assert.equal(second.entities.category,'running_shoes');
  assert.equal(second.entities.price.value,80);assert.equal(second.entities.price.currency,'USD');
  assert.equal(second.entities.productText,'blue running shoes');
  const third=resolve(c,'only Adidas',second.context.next);
  assert.equal(third.status,'RESOLVED');assert.equal(third.entities.brand,'Adidas');
  assert.equal(third.entities.color,'blue');assert.equal(third.entities.price.value,80);
  assert.ok(validContext(third.context.next,c.dictionary));
  const fourth=resolve(c,'budget 70',third.context.next);
  assert.equal(fourth.entities.price.currency,'USD');assert.equal(fourth.entities.price.value,70);
  const combined=resolve(c,'actually blue and Adidas',first.context.next);
  assert.equal(combined.entities.color,'blue');assert.equal(combined.entities.brand,'Adidas');
  const bounded=resolve(c,'find shoes between $50 and $100');
  const budget=resolve(c,'budget $80',bounded.context.next);
  assert.equal(budget.status,'RESOLVED');assert.match(budget.interpretationText!,/at least \$50/);
  assert.match(budget.interpretationText!,/up to \$80/);
  assert.equal(resolve(c,'budget EUR 80',bounded.context.next).status,'NEEDS_CONTEXT');
 });
 test(`${name}: corrections cannot erase exclusions or run a partial edit`,()=>{
  const first=resolve(c,'find milk under $5 but not almond milk');
  const second=resolve(c,'budget $4',first.context.next);
  assert.equal(second.status,'NEEDS_CONTEXT');assert.equal(second.entities.price.value,4);
  assert.equal(second.entities.requestConstraints[0].value,'almond milk');
  const search=resolve(c,'find black shoes under $100');
  for(const text of ['actually blue and checkout','actually blue or red','quantity -2 instead','actually blue without leather']){
   const r=resolve(c,text,search.context.next);assert.equal(r.status,'NEEDS_CONTEXT',text);
   assert.equal(r.context.next.activeSearch?.text,search.context.next.activeSearch?.text);
   assert.equal(r.operations?.length??0,0);assert.equal(r.entities.color,undefined);
  }
 });
 test(`${name}: missing, stale and forged search context cannot invent an action`,()=>{
  assert.equal(resolve(c,'actually blue').status,'NEEDS_CONTEXT');
  const first=resolve(c,'find black shoes under $100');
  for(const text of ['show my cart','hello','return shoes','write a poem']){
   const interrupted=resolve(c,text,first.context.next);
   assert.equal(interrupted.context.next.activeSearch,undefined,text);
   assert.equal(resolve(c,'actually blue',interrupted.context.next).status,'NEEDS_CONTEXT');
  }
  assert.equal(resolve(c,'quantity 3',{activeSearch:{text:'add milk to cart'}}).status,'NEEDS_CONTEXT');
  for(const context of [{activeSearch:{text:''}},{activeSearch:{text:'x'.repeat(4001)}},{activeSearch:{text:'find shoes',productId:'fake'}}])assert.equal(validContext(context,c.dictionary),false);
 });
 test(`${name}: quoted conditions and explicit new searches stay independent`,()=>{
  for(const phrase of ['only if delivery is free','without sugar','excluding Nike','actually blue']){
   const r=resolve(c,`find "${phrase}"`);assert.equal(r.status,'RESOLVED');
   assert.equal(r.entities.productText,phrase.toLowerCase());assert.equal(r.entities.requestConstraints,undefined);
  }
  const first=resolve(c,'find black shoes under $100');
  const next=resolve(c,'find white shirts under $40',first.context.next);
  assert.equal(next.entities.productText,'white shirts');assert.equal(next.entities.price.value,40);
 });
}
test('constraint source spans use Unicode code points and quoted markers remain literal',()=>{
 const text='🙂 find milk but not almond milk';
 const {constraints}=requestConstraints(text);assert.equal(constraints.length,1);
 assert.equal([...text].slice(constraints[0].start,constraints[0].end).join(''),'but not almond milk');
 assert.equal(requestConstraints('find "not milk" under $5').constraints.length,0);
 const both=requestConstraints('find milk but not almond milk only if it is in stock');
 assert.deepEqual(new Set(both.constraints.map(c=>c.kind)),new Set(['CONDITION','EXCLUSION']));
});
