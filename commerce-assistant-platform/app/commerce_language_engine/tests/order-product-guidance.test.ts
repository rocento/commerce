import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {orderProductGuidance} from '../src/product-guidance.ts';
import {resolve} from '../src/engine.ts';
import {loadRuntime} from '../src/runtime.ts';
const runtime=await loadRuntime();
test('orders naming products require selection and preserve each search',()=>{
 for(const message of ['create order : chesse and milk','create an order for chesse and milk','place order with chesse, milk']){
  const r=resolve(runtime,message);
  assert.equal(r.intent,'PRODUCT_ACTION_CHOICE');
  assert.equal(r.status,'NEEDS_CONTEXT');
  assert.deepEqual(r.entities.productQueries,['chesse','milk']);
  assert.equal(r.entities.guideAction,'cart');
  assert.deepEqual(r.actions,[]);
 }
});
test('plain checkout and negated or conditional requests are not product discovery',()=>{
 for(const message of ['create order','checkout','do not create order: milk','create order with milk if available','create order with milk; cancel order'])assert.equal(orderProductGuidance(message),undefined);
});

test('unpunctuated orders preserve separate product quantities without executing', () => {
 for (const message of ['create order 2 bananas', 'please create an order for 2 bananas', 'place order: two bananas']) {
  const result = resolve(runtime, message);
  assert.equal(result.intent, 'PRODUCT_ACTION_CHOICE');
  assert.deepEqual(result.entities.items, [{productText: 'bananas', quantity: 2}]);
  assert.equal(result.entities.guideAction, 'cart');
  assert.deepEqual(result.actions, []);
 }
 const result = resolve(runtime, 'create order 2 bananas and 3 apples');
 assert.deepEqual(result.entities.items, [{productText: 'bananas', quantity: 2}, {productText: 'apples', quantity: 3}]);
});
test('order discovery never drops constraints or invalid quantities', () => {
 for (const message of ['create order 0 bananas', 'create order -2 bananas', 'create order 1.5 bananas', 'create order 2 kg bananas', 'create order milk under $20', 'create order milk then pay', 'create order milk without sugar', 'create order milk if available']) {
  assert.equal(orderProductGuidance(message), undefined, message);
 }
});


test('polite order requests preserve merchant product text and quantities', () => {
 for (const prefix of ['pls', 'plz', 'please', 'can you', 'could you please', 'pls would you', 'would you pls']) {
  for (const product of ['banana', 'baladi', 'ring']) {
   const message = `${prefix} create order 2 ${product}`;
   const result = resolve(runtime, message);
   assert.equal(result.intent, 'PRODUCT_ACTION_CHOICE', message);
   assert.equal(result.status, 'NEEDS_CONTEXT');
   assert.deepEqual(result.entities.items, [{productText: product, quantity: 2}]);
   assert.equal(result.entities.guideAction, 'cart');
   assert.equal(result.entities.order_reference, undefined);
   assert.deepEqual(result.actions, []);
   assert.deepEqual(result.operations, []);
  }
 }
 const result = resolve(runtime, 'pls create order two bananas and one milk');
 assert.deepEqual(result.entities.items, [{productText: 'bananas', quantity: 2}, {productText: 'milk', quantity: 1}]);
});

test('polite prefixes preserve guards', () => {
 for (const request of ['0 bananas', '-2 bananas', '1.5 bananas', '2 kg bananas', 'milk under $20', 'milk without sugar', 'milk if available', 'milk then pay']) {
  assert.equal(orderProductGuidance(`pls create order ${request}`), undefined, request);
 }
 for (const message of ['pls do not create order 2 bananas', 'could you not create order 2 bananas', 'pls create order', 'pls cancel order 2']) {
  assert.equal(orderProductGuidance(message), undefined, message);
 }
});

test('count-first order lists preserve typos, local names and quantities without writes', () => {
 for (const message of ['please create order 2 banans 3 apples 2 baladi', 'create order 2 banans, 3 apples 2 baladi']) {
  const result = resolve(runtime, message);
  assert.equal(result.intent, 'PRODUCT_ACTION_CHOICE');
  assert.deepEqual(result.entities.items, [{productText: 'banans', quantity: 2}, {productText: 'apples', quantity: 3}, {productText: 'baladi', quantity: 2}]);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.operations, []);
 }
});
test('counted shorthand rejects invalid quantities, measurements and ambiguous model numbers', () => {
 for (const request of ['2 bananas 0 apples', '2 bananas -3 apples', '2 bananas 1.5 apples', '2 bananas 3 kg apples', '2 iphone 15 pro', '2 vitamin b 12 tablets', '2 bananas 3 apples if cheap']) {
  assert.equal(orderProductGuidance(`create order ${request}`), undefined, request);
 }
});

test('order quantity notation is fully consumed, including invalid values', () => {
 for (const message of ['order 2x bananas 3x apples', 'buy bananas x2, apples x3']) {
  assert.deepEqual(resolve(runtime, message).entities.items, [{productText:'bananas',quantity:2},{productText:'apples',quantity:3}]);
 }
 for (const message of ['order 0x bananas', 'order -2x bananas', 'order bananas x1.5', 'order 1.5x bananas']) {
  assert.equal(orderProductGuidance(message), undefined, message);
  assert.notEqual(resolve(runtime, message).status, 'RESOLVED', message);
 }
});
test('conversational purchase heads do not consume availability questions or rewrite product typos', () => {
 assert.equal(orderProductGuidance('Have you got linen napkins?'), undefined);
 assert.equal(orderProductGuidance('get my order details'), undefined);
 assert.deepEqual(resolve(runtime, 'hello! could u please ordar twelve banans?').entities.items, [{productText:'banans',quantity:12}]);
});

 test('desire and polite lists share the order route for arbitrary products and counts', () => {
  for (const prefix of ['create order', 'I need', 'I want', "I'd like", 'please', 'pls', 'plz', 'kindly']) {
   for (const list of ['1 banana 2 apple', 'one banana two apple', '1 banana and two apple']) {
    const result = resolve(runtime, `${prefix} ${list}`);
    assert.equal(result.intent, 'PRODUCT_ACTION_CHOICE');
    assert.deepEqual(result.entities.items, [{productText:'banana',quantity:1},{productText:'apple',quantity:2}]);
    assert.deepEqual(result.actions, []);
   }
   const result = resolve(runtime, `${prefix} 7 green tea 12 red apples 3 linen napkins 4 cheese 6 baladi 9 rings`);
   assert.deepEqual(result.entities.items, [
    {productText:'green tea',quantity:7},{productText:'red apples',quantity:12},
    {productText:'linen napkins',quantity:3},{productText:'cheese',quantity:4},
    {productText:'baladi',quantity:6},{productText:'rings',quantity:9}]);
  }
 });
 test('expanded lists keep quantity, condition and request limits', () => {
  for (const prefix of ['I need', 'please']) {
   for (const list of ['0 bananas', '-2 bananas', '1.5 bananas', '2 kg bananas', '2 bananas if cheap', '2 iphone 15 pro'])
    assert.equal(orderProductGuidance(`${prefix} ${list}`), undefined);
  }
  assert.equal(orderProductGuidance('please tell me about apples'), undefined);
  assert.equal(orderProductGuidance('I need help with my order'), undefined);
  const list = Array.from({length:50}, () => '2 apples').join(', ');
  assert.equal(orderProductGuidance(`I need ${list}`)?.length, 50);
  assert.equal(orderProductGuidance(`I need ${list}, 3 bananas`), undefined);
 });

