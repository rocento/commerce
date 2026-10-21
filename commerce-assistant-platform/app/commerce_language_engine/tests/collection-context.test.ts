import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
const c=compile(buildExpandedDictionary());
test('omitted collection requests client context without guessing cart',()=>{
 for(const text of ['delete high items value','remove expensive items','please delete these products']){
  const r=resolve(c,text);
  assert.equal(r.status,'NEEDS_CONTEXT',text);assert.equal(r.intent,null);
  assert.deepEqual(r.missing,['collection']);assert.deepEqual(r.contextRequest?.options,['cart','wishlist']);
  assert.deepEqual(r.context.next,{pendingRequest:text});assert.equal(r.fulfillment,undefined);
 }
});
test('explicit collection and client-supplied collection resolve the same action',()=>{
 assert.equal(resolve(c,'delete high items value from cart').intent,'REMOVE_FROM_CART');
 for(const [collection,intent] of [['cart','REMOVE_FROM_CART'],['wishlist','REMOVE_FROM_WISHLIST']]){
  const r=resolve(c,'delete high items value',{collection});
  assert.equal(r.status,'RESOLVED');assert.equal(r.intent,intent);
  assert.equal(r.debug.score,12);assert.ok(r.evidence.some(e=>e.kind==='CONTEXT'&&e.score===3));
  assert.equal(r.entities.productText,'high items value');
  assert.ok(!r.debug.tokens.includes(collection));
 }
});
test('explicit collection takes precedence over client collection',()=>{
 const r=resolve(c,'delete high items value from cart',{collection:'wishlist'});
 assert.equal(r.status,'RESOLVED');assert.equal(r.intent,'REMOVE_FROM_CART');assert.equal(r.debug.score,13);
});
test('negation, instructions, bare commands and unrelated objects do not ask collection context',()=>{
 for(const text of ["don't delete high items value",'how to delete high items value','write a story about deleting items','delete','delete my account','delete items from an order','delete items and add products']){
  const r=resolve(c,text);assert.equal(r.contextRequest,undefined,text);assert.notEqual(r.intent,'REMOVE_FROM_CART',text);
 }
});

test('missing context keeps specific questions while other statuses also have messages',()=>{
 const collection=resolve(c,'delete high items value');
 assert.equal(collection.message,'Which collection do you mean: cart or wishlist?');
 const product=resolve(c,'add two items to cart');
 assert.equal(product.status,'NEEDS_CONTEXT');assert.equal(product.message,'Which product or items do you mean?');
 const both=resolve(c,'add two or three items to cart');
 assert.ok(both.message?.includes('How many items'));assert.ok(both.message?.includes('Which product'));
 for(const text of ['add strawberries to cart','new order','nonsense'])assert.ok(resolve(c,text).message.length>0);
});
