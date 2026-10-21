import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {actionInterpretationConflicts} from '../src/action-agreement.ts';
const runtime = await loadRuntime();

test('complete supported pairs have a consistent compound interpretation', () => {
  for (const text of ['add banana to cart and also to wishlist', 'add banana to cart and also apple to wishlist']) {
    const r = resolve(runtime, text);
    assert.equal(r.intentCount, 2);
    assert.equal(r.requestedActionsVersion, 1);
    assert.equal(r.status, 'RESOLVED');
    assert.equal(r.compoundInterpretationVersion, 1);
    assert.equal(r.intent, null);
    assert.equal(r.requestType, 'MULTI_ACTION');
    assert.deepEqual(r.requestedActionIssues, []);
    assert.deepEqual(r.missing, []);
    assert.equal(r.fulfillment?.status, 'NOT_EXECUTED');
    assert.equal(r.context.next.pendingRequest, undefined);
  }
});

test('whole-request domain recognizers retain their meaning', () => {
  for (const [text, intent] of [
    ['remove all items from cart', 'CLEAR_CART'],
    ['take out all products from my comparison list', 'CLEAR_COMPARISON'],
    ['drop earrings', 'PRODUCT_SEARCH'],
    ['add banana to cart just kidding', 'CONVERSATION_JOKE'],
    ['remove 12 copper fasteners from my wishlist and put them in my cart', 'CART_MOVE_FROM_WISHLIST'],
    ['save banana for later', 'ADD_TO_WISHLIST'],
  ]) {
    const r = resolve(runtime, text);
    assert.equal(r.status, 'RESOLVED', text);
    assert.equal(r.intentCount, 1, text);
    assert.equal(r.requestedActions[0].intent, intent, text);
    assert.deepEqual(r.requestedActionIssues, [], text);
  }
});

test('reports bounded structured uncertainty without exporting invalid quantities', () => {
  for (const [text, reason] of [
    ['add it to cart and also to wishlist', 'UNRESOLVED_PRODUCT'],
    ['add banana to cart or to wishlist', 'ALTERNATIVE_ACTIONS'],
    ['add banana to cart if cheap', 'CONDITIONAL_REQUEST'],
    ['add 1000001 bananas to cart', 'INVALID_QUANTITY'],
    ['add zero bananas to cart', 'INVALID_QUANTITY'],
  ]) {
    const r = resolve(runtime, text);
    assert.equal(r.intentCountStatus, 'NEEDS_CLARIFICATION', text);
    assert.equal(r.intentCount, null, text);
    assert.ok(r.requestedActionIssues.includes(reason as typeof r.requestedActionIssues[number]), text);
    assert.ok(r.requestedActions.every(a => a.items.every(i => i.quantity === undefined || Number.isSafeInteger(i.quantity) && i.quantity > 0 && i.quantity <= 1000000)));
  }
  const bounded = resolve(runtime, `add ${Array.from({length:51}, (_,i) => `one item${i}`).join(' and ')} to cart`);
  assert.deepEqual(bounded.requestedActionIssues, ['REQUEST_LIMIT']);
  assert.deepEqual(bounded.requestedActions, []);
});

test('agreement preserves action multiplicity and order, not preparation operations', () => {
  const r = resolve(runtime, 'add banana to cart and remove apple from cart');
  assert.equal(actionInterpretationConflicts(r, r), false);
  assert.equal(actionInterpretationConflicts(r, {...r, requestedActions: [...r.requestedActions].reverse()}), true);
  assert.equal(actionInterpretationConflicts(r, {...r, requestedActions: r.requestedActions.slice(0, 1)}), true);
  const order = resolve(runtime, 'create order for two apples and deliver to my home address');
  assert.equal(order.status, 'RESOLVED');
  assert.equal(order.operations?.length, 3);
  assert.equal(order.intentCount, 2);
});

test('an exact count never upgrades a pre-existing non-resolved interpretation', () => {
  const r = resolve(runtime, 'add some bananas to cart and add apple to wishlist');
  assert.equal(r.intentCount, 2);
  assert.equal(r.compoundInterpretationVersion, undefined);
  assert.notEqual(r.status, 'RESOLVED');
});
