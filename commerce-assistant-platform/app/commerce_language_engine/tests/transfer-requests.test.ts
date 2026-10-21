import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {validContext} from '../src/context.ts';
import {transferCases} from '../src/generation/transfer-cases.ts';
const dictionary=buildExpandedDictionary(),compiled=compile(dictionary);
test('advanced transfer cases preserve direction, quantities and negative boundaries',()=>{
 for(const c of transferCases()){
  const r=resolve(compiled,c.text,c.context);
  assert.equal(r.status,c.status,c.text);assert.equal(r.intent,c.intent,c.text);
  for(const [key,value] of Object.entries(c.entities??{}))assert.deepEqual(r.entities[key],value,c.text+' / '+key);
  if(r.intent){assert.equal(r.fulfillment?.status,'NOT_EXECUTED');assert.equal(r.requiresConfirmation,true);}
  assert.ok(validContext(r.context.next,dictionary),c.text);
 }
});
test('item clarification keeps the original transfer direction and quantity',()=>{
 const first=resolve(compiled,'move two items from wishlist to cart');
 assert.equal(first.status,'NEEDS_CONTEXT');assert.deepEqual(first.missing,['productReference']);
 const reply=resolve(compiled,'black shoes',first.context.next);
 assert.equal(reply.status,'RESOLVED');assert.equal(reply.intent,'CART_MOVE_FROM_WISHLIST');
 assert.equal(reply.entities.quantity,2);assert.equal(reply.entities.productText,'black shoes');
 assert.equal(reply.entities.sourceCollection,'wishlist');assert.equal(reply.entities.destination,'cart');
 assert.equal(reply.context.next.pendingRequest,undefined);
 const fresh=resolve(compiled,'show my cart',first.context.next);assert.equal(fresh.intent,'VIEW_CART');
 const invalidQuantity=resolve(compiled,'move zero shoes from wishlist to cart');
 const corrected=resolve(compiled,'two',invalidQuantity.context.next);
 assert.equal(corrected.status,'RESOLVED');assert.equal(corrected.entities.quantity,2);assert.equal(corrected.entities.productText,'shoes');
});
test('a pronoun requires an item in the matching source collection',()=>{
 for(const collection of ['wishlist','cart']){
  const r=resolve(compiled,'move it from wishlist to cart',{collection,selectedItems:[{productText:'black shoes'}]});
  assert.equal(r.status,collection==='wishlist'?'RESOLVED':'NEEDS_CONTEXT');
 }
 assert.equal(resolve(compiled,'move it from wishlist to cart',{states:['PRODUCT_SELECTED']}).status,'NEEDS_CONTEXT');
});
test('multiple transfer items do not invent a single product or silently accept an unspecified line',()=>{
 const result=resolve(compiled,'move two socks and three mugs from wishlist to cart');
 assert.equal(result.entities.productText,undefined);assert.equal(result.entities.quantity,undefined);
 assert.equal(result.entities.line_items.length,2);
 assert.equal(resolve(compiled,'move two items and three mugs from wishlist to cart').status,'NEEDS_CONTEXT');
 assert.equal(resolve(compiled,'move zero socks and three mugs from wishlist to cart').status,'NEEDS_CONTEXT');
});

test('all and any resume wishlist selection without granting execution',()=>{
 const first=resolve(compiled,'pls move wishlist to cart');
 assert.equal(first.status,'NEEDS_CONTEXT');
 for(const [reply,selection] of [['all','ALL_SAVED'],['any','RANDOM_SAVED'],['any one','RANDOM_SAVED']]){
  for(const result of [resolve(compiled,reply,first.context.next),resolve(compiled,`move ${reply} from wishlist to cart`)]){
   assert.equal(result.status,'RESOLVED',reply);
   assert.equal(result.intent,'CART_MOVE_FROM_WISHLIST');
   assert.equal(result.entities.selection,selection);
   assert.equal(result.entities.sourceCollection,'wishlist');
   assert.equal(result.entities.destination,'cart');
   assert.equal(result.fulfillment?.status,'NOT_EXECUTED');
   assert.equal(result.entities.quantity,undefined);
  }
 }
 for(const text of ['do not move all from wishlist to cart','how do I move any from wishlist to cart']){
  const result=resolve(compiled,text);
  assert.notEqual(result.status,'RESOLVED',text);
 }
});
