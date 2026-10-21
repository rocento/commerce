import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {requestEnvelope} from '../src/request-envelope.ts';
const compiled=await loadRuntime();

test('whole governed nouns survive polite framing and generic product meanings',()=>{
 const reads=[['rules for returns','RETURN_POLICY'],['ready for collection','PICKUP_READY'],['nutritional information','PRODUCT_NUTRITION'],['certification details','PRODUCT_CERTIFICATION'],['storage life','PRODUCT_SHELF_LIFE'],['memory capacity','PRODUCT_STORAGE_CAPACITY']];
 for(const [noun,intent] of reads)for(const text of [`show ${noun}`,`I was hoping you could show the ${noun}`,`if possible, show my ${noun}`]){
  const result=resolve(compiled,text);assert.equal(result.intent,intent,text);assert.equal(result.status,'RESOLVED',text);
  assert.equal(result.entities.catalogPurpose,undefined,text);assert.equal(result.entities.shoppingContext,undefined,text);
  assert.equal(result.requestedActions.length,1,text);assert.equal(result.requestedActions[0].intent,intent,text);
 }
});

test('new reviewed object forms use dictionary ownership without parser branches',()=>{
 const dictionary=structuredClone(compiled.dictionary);
 dictionary.groups.find(group=>group.code==='OBJECT_PRODUCT_CERTIFICATIONS')!.terms.push('conformity credentials');
 const extended=compile(dictionary);
 const result=resolve(extended,'could you help me show conformity credentials');
 assert.equal(result.intent,'PRODUCT_CERTIFICATION');assert.equal(result.status,'RESOLVED');
});

test('generic any-item instructions require a product without inventing selections',()=>{
 for(const [verb,collection,intent] of [['add','cart','ADD_TO_CART'],['place','wishlist','ADD_TO_WISHLIST'],['take','cart','REMOVE_FROM_CART'],['take','wishlist','REMOVE_FROM_WISHLIST']]){
  const prep=verb==='take'?'from':'in';
  const result=resolve(compiled,`${verb} any two fresh items ${prep} my ${collection}`);
  assert.equal(result.intent,intent);assert.equal(result.status,'NEEDS_CONTEXT');assert.equal(result.entities.quantity,2);assert.equal(result.entities.selection,'ANY_MATCHING');
  assert.equal(result.fulfillment?.needsClarification,true);
 }
});

test('explicit wishlist nouns retain their removal count and target',()=>{
 for(const text of ['take any two mangosteens from my wishlist','i want to take any two organic apples from my wishlist','help me take any two organic apples from my wishlist','place two shirts in my favourites']){
  const result=resolve(compiled,text);assert.equal(result.status,'RESOLVED',text);assert.match(result.intent!,/WISHLIST$/);
  assert.equal(result.requestedActions.length,1);assert.equal(result.requestedActions[0].intent,result.intent);
 }
});

test('an unresolved collection command cannot turn into a contextual product search',()=>{
 for(const collection of ['cart','wishlist']){
  const result=resolve(compiled,`pls i need take any two fresh items from my ${collection}`);
  assert.equal(result.intent,collection==='cart'?'REMOVE_FROM_CART':'REMOVE_FROM_WISHLIST');assert.equal(result.status,'NEEDS_CONTEXT');
  assert.equal(result.entities.selection,'ANY_MATCHING');assert.equal(result.entities.freshness,'fresh');assert.equal(result.entities.shoppingContext,undefined);
 }
});

test('all governed cart count verbs retain the established quantity-and-money read',()=>{
 for(const text of ['show cart item count','inspect basket item count','I was hoping you could display my cart item count']){
  const result=resolve(compiled,text);assert.equal(result.intent,'CART_TOTAL',text);assert.equal(result.status,'RESOLVED',text);
 }
});

test('cancelling a duplicate order is a guarded cancellation request',()=>{
 const result=resolve(compiled,'I was hoping you could cancel my repeated order');
 assert.equal(result.intent,'CANCEL_ORDER');assert.equal(result.status,'RESOLVED');assert.equal(result.requiresConfirmation,true);
 assert.equal(result.requestedActions[0].intent,'CANCEL_ORDER');
});

test('ordinal product nouns select only an existing product result context',()=>{
 const product=resolve(compiled,'second product',{previousIntent:'PRODUCT_SEARCH',states:['PRODUCT_RESULTS_VISIBLE']});
 assert.equal(product.intent,'SELECT_PRODUCT');assert.equal(product.status,'RESOLVED');assert.equal(product.entities.ordinal,2);
 const order=resolve(compiled,'second product',{previousIntent:'ORDER_HISTORY',states:['ORDER_LIST_VISIBLE']});assert.equal(order.intent,null);assert.equal(order.status,'UNKNOWN');
});

test('order-list repeat fragments never imply that an order was selected',()=>{
 for(const text of ['again','another time','anew','a second time','once again','once more','one more time']){
  const result=resolve(compiled,text,{previousIntent:'ORDER_HISTORY',states:['ORDER_LIST_VISIBLE']});
  assert.equal(result.intent,'REORDER',text);assert.equal(result.status,'NEEDS_CONTEXT',text);assert.ok(result.missing?.includes('orderReference'),text);
 }
});

test('reviewed order noun corrections preserve authorization lookup requirements',()=>{
 const normal=resolve(compiled,'reorder my last order'),typo=resolve(compiled,'reorder my last ordar');
 assert.equal(typo.status,normal.status);assert.deepEqual(typo.entities.order,normal.entities.order);
 assert.equal(typo.entities.order.requiresAuthorizationLookup,true);assert.equal(typo.entities.order.resolvedReference,undefined);
});

test('dangling determiners and bare tracking verbs do not fabricate objects',()=>{
 for(const text of ['please add the','find my','remove our','track my','could you trace','please track the']){
  const result=resolve(compiled,text);assert.equal(result.intent,null,text);assert.equal(result.status,'UNKNOWN',text);
 }
});

test('wrapper normalization leaves substantive conditions and later sentences intact',()=>{
 assert.equal(requestEnvelope('Can I return Acme Notebook if it is not right for me?'),undefined);
 assert.equal(requestEnvelope('Can you show milk? Add it to my cart.'),undefined);
 const result=resolve(compiled,'I was hoping you could add milk to cart only if delivery is free');
 assert.equal(result.status,'NEEDS_CONTEXT');assert.equal(result.entities.requestConstraints[0].text,'only if delivery is free');
});
