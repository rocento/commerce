import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
const runtime = await loadRuntime();

test('counts actions independently of quantities, products and intent types', () => {
  for (const [text, count, unique] of [
    ['add 1 banana to cart', 1, 1],
    ['add 5 bananas to cart', 1, 1],
    ['add bananas and apples to cart', 1, 1],
    ['add 1 banana to cart and add 2 apples to cart', 2, 1],
    ['add 1 banana to cart and also to wishlist', 2, 2],
    ['add to cart 1 banana then also to wishlist', 2, 2],
    ['add banana to cart then show my cart', 2, 2],
    ['add banana to cart, actually wishlist instead', 1, 1],
    ['do not add banana to cart', 0, 0],
    ["don't checkout", 0, 0],
    ['add it to cart, actually add banana to wishlist instead', 1, 1],
    ['add banana to cart but do not checkout', 1, 1],
  ] as const) {
    const r = resolve(runtime, text);
    assert.equal(r.intentCountStatus, 'EXACT', text);
    assert.equal(r.intentCount, count, text);
    assert.equal(r.uniqueIntentCount, unique, text);
  }
});

test('inherits products for omitted destination actions and preserves sequence', () => {
  const r = resolve(runtime, 'add to cart 1 banana then also to wishlist');
  assert.deepEqual(r.requestedActions.map(a => a.intent), ['ADD_TO_CART', 'ADD_TO_WISHLIST']);
  assert.deepEqual(r.requestedActions.map(a => a.items), [[{productText: 'banana', quantity: 1}], [{productText: 'banana', quantity: 1}]]);
  assert.equal(r.requestedActions[1].after, r.requestedActions[0].id);
  const corrected = resolve(runtime, 'add banana to cart, actually wishlist instead');
  assert.deepEqual(corrected.requestedActions.map(a => a.intent), ['ADD_TO_WISHLIST']);
  assert.deepEqual(corrected.requestedActions[0].items, [{productText: 'banana'}]);
});

test('product lists and quoted conjunctions stay inside a single action', () => {
  const list = resolve(runtime, 'add bananas and apples to wishlist');
  assert.equal(list.intentCount, 1);
  assert.equal(list.requestedActions[0].intent, 'ADD_TO_WISHLIST');
  assert.deepEqual(list.requestedActions[0].items.map(i => i.productText), ['bananas', 'apples']);
  const quoted = resolve(runtime, 'add one "salt and pepper" to cart');
  assert.equal(quoted.intentCount, 1);
  assert.equal(quoted.requestedActions[0].items[0].productText, 'salt and pepper');
});

test('clarifies uncertainty instead of reporting an exact count', () => {
  for (const text of ['add banana to cart or to wishlist', 'add it to cart and also to wishlist', 'add banana to cart then dance', 'checkout then dance', 'add banana to cart if cheap', 'create an order or cancel my order', 'nonsense xyz']) {
    const r = resolve(runtime, text);
    assert.equal(r.intentCountStatus, 'NEEDS_CLARIFICATION', text);
    assert.equal(r.intentCount, null, text);
    assert.equal(r.uniqueIntentCount, null, text);
  }
});

test('counts customer clauses rather than internal preparation operations', () => {
  const r = resolve(runtime, 'create order for two apples and deliver to my home address');
  assert.equal(r.intentCount, 2);
  assert.equal(r.operations?.length, 3);
  assert.equal(r.fulfillment?.status, 'NOT_EXECUTED');
  assert.deepEqual(r.requestedActions[0].items, [{productText: 'apples', quantity: 2}]);
});

test('context resolves a product reference without granting execution authority', () => {
  const r = resolve(runtime, 'add it to cart and also to wishlist', {selectedItems: [{productText: 'banana'}]});
  assert.equal(r.intentCount, 2);
  assert.deepEqual(r.requestedActions.map(a => a.items[0].productText), ['banana', 'banana']);
});

test('retains domain intent aliases and does not invent a collection destination', () => {
  const saved = resolve(runtime, 'save banana for later');
  assert.equal(saved.intentCount, 1);
  assert.equal(saved.requestedActions[0].intent, 'ADD_TO_WISHLIST');
  assert.equal(saved.requestedActions[0].items[0].productText, 'banana');
  const coupon = resolve(runtime, 'add coupon SAVE10');
  assert.equal(coupon.requestedActions[0].intent, 'APPLY_COUPON');
  for (const text of ['add banana to shopping list', 'remove banana from this sentence', 'show my cart and dance']) assert.equal(resolve(runtime, text).intentCount, null, text);
});

test('supports a changed product in an omitted add clause and the bounded card typo', () => {
  const changed = resolve(runtime, 'add banana to cart and also apple to wishlist');
  assert.equal(changed.intentCount, 2);
  assert.deepEqual(changed.requestedActions.map(a => [a.intent, a.items[0].productText]), [['ADD_TO_CART', 'banana'], ['ADD_TO_WISHLIST', 'apple']]);
  assert.equal(resolve(runtime, 'add to card 1 banana and also to wishlist').intentCount, 2);
  const product = resolve(runtime, 'add one "gift card" to cart');
  assert.equal(product.requestedActions[0].items[0].productText, 'gift card');
});

test('bounds interpretation and retains an exact zero for negated commands', () => {
  assert.equal(resolve(runtime, Array.from({length: 34}, () => 'add banana to cart').join(' then ')).intentCount, null);
  const negative = resolve(runtime, "don't add banana to cart and do not add apple to wishlist");
  assert.equal(negative.intentCount, 0);
  assert.deepEqual(negative.requestedActions, []);
});
