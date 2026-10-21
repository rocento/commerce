import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';

for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: sequence markers retain items before checkout`,()=>{
  for(const text of ['first add 30 tea kettles and 2 yogurt, then start checkout','please first add two copper fasteners and three linen napkins then start checkout']){
   const r=resolve(c,text);
   assert.equal(r.status,'RESOLVED',text);assert.equal(r.entities.items.length,2);
   assert.deepEqual(r.operations,['ADD_ITEM','START_CHECKOUT']);
   assert.equal(r.fulfillment?.status,'NOT_EXECUTED');assert.equal(r.requiresConfirmation,true);
  }
  const r=resolve(c,'first do not add shoes then start checkout');
  assert.ok(!r.operations?.includes('ADD_ITEM'));
 });
 test(`${name}: direct orders retain items through address clarification`,()=>{
  for(const text of ["I'd like to order 19 frozen peas; deliver them there",'order 19 frozen peas and ship it there','we would like to order 19 frozen peas and send them there']){
   const first=resolve(c,text);
   assert.equal(first.status,'NEEDS_CONTEXT',text);assert.equal(first.intent,'CREATE_ORDER');
   assert.deepEqual(first.entities.items,[{quantity:19,productText:'frozen peas'}]);
   for(const address of ['work','home']){
    const r=resolve(c,address,first.context.next);
    assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'CREATE_ORDER');
    assert.deepEqual(r.entities.items,first.entities.items);
    assert.equal(r.entities.delivery.addressReference,address.toUpperCase());
    assert.deepEqual(r.operations,['ADD_ITEM','SET_DELIVERY_ADDRESS','CREATE_ORDER']);
    assert.equal(r.fulfillment?.status,'NOT_EXECUTED');
   }
  }
 });
 test(`${name}: passive cart requests preserve quantities through a product reply`,()=>{
  for(const text of ["I'd like 5 products added to my cart",'we would like five items added to our basket']){
   const first=resolve(c,text);assert.equal(first.status,'NEEDS_CONTEXT',text);
   assert.equal(first.intent,'ADD_TO_CART');
   const r=resolve(c,'copper fasteners',first.context.next);
   assert.equal(r.status,'RESOLVED');assert.equal(r.intent,'ADD_TO_CART');
   assert.deepEqual(r.entities.items,[{quantity:5,productText:'copper fasteners'}]);
   assert.equal(r.fulfillment?.status,'NOT_EXECUTED');
   assert.equal(resolve(c,'show my cart',first.context.next).intent,'VIEW_CART');
  }
  for(const text of ["I'd like -5 products added to my cart",'order -7 shoes and deliver them home']){
   assert.equal(resolve(c,text).status,'NEEDS_CONTEXT',text);
  }
  assert.notEqual(resolve(c,"I'd like no products added to my cart").status,'RESOLVED');
 });
}
