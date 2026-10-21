import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';

for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: linked transfer commands preserve direction and quantity`,()=>{
  for(const [source,target,intent,verb] of [['wishlist','cart','CART_MOVE_FROM_WISHLIST','put'],['cart','wishlist','CART_MOVE_TO_WISHLIST','save']]){
   for(const lead of ['take','remove'])for(const prefix of ['','could you please ']){
    const text=`${prefix}${lead} 12 copper fasteners from my ${source} and ${verb} them in my ${target}`;
    const r=resolve(c,text);
    assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,intent,text);
    assert.equal(r.entities.productText,'copper fasteners',text);assert.equal(r.entities.quantity,12,text);
    assert.equal(r.entities.sourceCollection,source);assert.equal(r.entities.destination,target);
    assert.equal(r.fulfillment?.status,'NOT_EXECUTED');assert.equal(r.requiresConfirmation,true);
   }
  }
 });
 test(`${name}: linked transfers retain invalid-quantity clarification`,()=>{
  for(const q of ['-7','3.5','0','1000001']){
   const r=resolve(c,`take ${q} shoes from wishlist and put them in cart`);
   assert.equal(r.status,'NEEDS_CONTEXT');assert.equal(r.intent,'CART_MOVE_FROM_WISHLIST');
   assert.equal(r.entities.quantity,Number(q));assert.equal(r.fulfillment?.status,'NOT_EXECUTED');
  }
 });
 test(`${name}: different objects, negation and trailing commands cannot resolve as one transfer`,()=>{
  for(const text of ['do not take shoes from wishlist and put them in cart','explain how to take shoes from wishlist and put them in cart']){
   const r=resolve(c,text);assert.equal(r.status,'UNKNOWN',text);assert.equal(r.intent,null,text);
  }
  for(const text of [
   'take shoes from wishlist and put mugs in cart',
   'take shoes from wishlist and do not put them in cart',
   'do not take shoes from wishlist and put them in cart',
   'explain how to take shoes from wishlist and put them in cart',
   'take shoes from wishlist and put them in cart then remove mugs from cart',
  ]){
   const r=resolve(c,text);
   assert.ok(r.status!=='RESOLVED'||!['CART_MOVE_FROM_WISHLIST','CART_MOVE_TO_WISHLIST'].includes(r.intent??''),text);
  }
 });
}
