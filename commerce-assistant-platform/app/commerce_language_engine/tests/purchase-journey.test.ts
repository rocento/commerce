import './recognition-test-context.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from '../src/runtime.ts';
import { resolve } from '../src/engine.ts';
import { orderProductGuidance } from '../src/product-guidance.ts';
import { extract } from '../src/entities.ts';
const runtime = await loadRuntime();

test('purchase paraphrases preserve quantities and require exact product selection', () => {
 for (const text of ['buy 2 bananas', 'purchase two bananas', 'order 2 bananas', 'I want to order two bananas', 'I would like to buy two bananas', 'can I get 2 bananas?', 'could I have two bananas please?', 'I would like two bananas', "I'd like two bananas", 'please buy 2 bananas']) {
  const result = resolve(runtime, text);
  assert.equal(result.intent, 'PRODUCT_ACTION_CHOICE', text);
  assert.equal(result.status, 'NEEDS_CONTEXT', text);
  assert.deepEqual(result.entities.items, [{ productText: 'bananas', quantity: 2 }], text);
  assert.equal(result.entities.order_reference, undefined, text);
  assert.deepEqual(result.operations, []);
 }
 assert.deepEqual(resolve(runtime, 'buy two bananas and three apples').entities.items, [{productText:'bananas',quantity:2},{productText:'apples',quantity:3}]);
});
test('existing-order references resolve to reads without product or creation actions', () => {
 for (const text of ['order number 2', 'order id 2', 'order #2', 'order 2', 'show me order number 2', 'please view my order #2']) {
  const result = resolve(runtime, text);
  assert.equal(result.intent, 'ORDER_DETAILS', text);
  assert.equal(result.status, 'RESOLVED', text);
  assert.equal(result.entities.order_reference, '2', text);
  assert.equal(result.entities.items, undefined, text);
  assert.equal(result.requiresConfirmation, false);
 }
 assert.equal(extract('order 2 bananas', []).order_reference, undefined);
 assert.equal(extract('order number 2', []).order_reference, '2');
 assert.equal(extract('track order 2 please', []).order_reference, '2');
});
test('an order-reference reply still completes a pending repeat-order request', () => {
 const first = resolve(runtime, 'repeat my last order and deliver it tomorrow morning');
 const next = resolve(runtime, 'order 15', {...first.context.next, referenceDate:'2026-09-22', timezone:'Africa/Cairo'});
 assert.equal(next.entities.order.resolvedReference, '15');
 assert.equal(next.entities.delivery.date, '2026-09-23');
 assert.deepEqual(next.operations, ['SET_DELIVERY_TIME','REPEAT_ORDER']);
});
test('whole checkout phrases start review without creating an order', () => {
 for (const text of ['checkout', 'please checkout', 'check out', 'continue to checkout']) {
  const result = resolve(runtime, text);
  assert.equal(result.intent, 'START_CHECKOUT');
  assert.equal(result.status, 'RESOLVED');
 }
 for (const text of ['do not checkout', 'checkout if under 50 EGP']) assert.notEqual(resolve(runtime,text).status, 'RESOLVED');
});
test('discovery excludes existing orders, repeats, conditions and extra actions', () => {
 for (const text of ['can I get a refund', 'can I get help', 'can I get my receipt', 'order number 2', 'repeat my last order', 'buy what I bought before', 'buy the same things again', 'buy milk then pay', 'buy milk without sugar', 'buy milk under $20', 'buy 2 kg bananas', 'buy -2 bananas', 'buy 1.5 bananas', 'can I get bananas if available', 'do not buy bananas', 'order milk and cancel order 2']) {
  assert.equal(orderProductGuidance(text), undefined, text);
 }
});
