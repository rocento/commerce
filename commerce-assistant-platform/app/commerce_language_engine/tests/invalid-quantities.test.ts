import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
const c=await loadRuntime();

test('invalid numeric prefixes require quantity clarification without fallback',()=>{
 for(const q of ['-7','−7','-0.5','5.5','.5','0','1000001','999999999999999999999']){
  for(const text of [`add ${q} apples to my cart`,`remove ${q} apples from my cart`,`move ${q} apples from my wishlist to my cart`,`add ${q} apples to my cart, budget $299`]){
   const r=resolve(c,text);assert.equal(r.status,'NEEDS_CONTEXT',text);
   assert.ok(r.missing?.some(v=>v.includes('quantity')),text);
   assert.equal(r.fulfillment?.status,'NOT_EXECUTED',text);
   assert.equal(r.text,text);
  }
 }
});
test('invalid quantities cannot disappear inside compound requests',()=>{
 for(const text of ['add 2 apples and -3 mugs then checkout','add 2 apples and 3.5 mugs then checkout','create an order for -2 apples and deliver to home','add -2 apples and 2 mugs to my cart']){
  const r=resolve(c,text);assert.equal(r.status,'NEEDS_CONTEXT',text);assert.ok(r.missing?.some(v=>v.includes('quantity')),text);
  assert.ok(r.entities.items.some((i:any)=>i.quantity<0||!Number.isInteger(i.quantity)),text);
 }
});
test('valid quantities, quoted numeric names and numeric SKUs stay intact',()=>{
 for(const [q,expected] of [['1',1],['1000000',1000000],['two',2],['half a dozen',6],['twenty-one',21]] as const){
  const r=resolve(c,`add ${q} apples to my cart`);assert.equal(r.status,'RESOLVED');assert.equal(r.entities.quantity,expected);
 }
 for(const name of ['3.5mm cables','B-52 model','7-up soda','"3.5 shoes"','"-7 model"','"12345"']){
  const r=resolve(c,`add ${name} to my cart`);assert.equal(r.status,'RESOLVED',name);assert.equal(r.entities.quantity,undefined,name);assert.equal(r.entities.productText,name.replaceAll('"','').toLowerCase(),name);
 }
 const r=resolve(c,'add 3.5mm cables and 2 mugs then checkout');
 assert.equal(r.status,'RESOLVED');assert.equal(r.entities.items[0].productText,'3.5mm cables');assert.equal(r.entities.items[0].quantity,undefined);
 assert.equal(resolve(c,'add -2 "3.5 shoes" to my cart').status,'NEEDS_CONTEXT');
 assert.equal(resolve(c,"don't add -2 apples to my cart").status,'UNKNOWN');
});
