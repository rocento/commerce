import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {compoundRequest} from '../src/compound-language.ts';
import {actionInterpretationConflicts} from '../src/action-agreement.ts';

const runtime = await loadRuntime();

test('one complete interpretation drives ordered actions, counts and graph', () => {
  for (const [text, products, quantities, after] of [
    ['add 1 banana to cart and add 1 banana to wishlist', ['banana', 'banana'], [1, 1], false],
    ['add to card 1 banana then also to wishlist', ['banana', 'banana'], [1, 1], true],
    ['add 2 bananas to cart and also apple to wishlist', ['bananas', 'apple'], [2, undefined], false],
    ['please add a banana to my basket then add it to my wishlist', ['banana', 'banana'], [1, 1], true],
    ['could you please save apple to wishlist, then add 3 bananas to cart please!', ['apple', 'bananas'], [undefined, 3], true],
    ['add "salt and pepper" to cart and add "gift card" to wishlist', ['salt and pepper', 'gift card'], [undefined, undefined], false],
    ['add "3.5mm adapter" to cart; add "same" to wishlist', ['3.5mm adapter', 'same'], [undefined, undefined], false],
  ] as const) {
    const r = resolve(runtime, text);
    assert.equal(r.compoundInterpretationVersion, 1, text);
    assert.equal(r.status, 'RESOLVED', text);
    assert.equal(r.intent, null);
    assert.equal(r.primaryIntent, null);
    assert.equal(r.requestType, 'MULTI_ACTION');
    assert.equal(r.intentCount, 2);
    assert.equal(r.uniqueIntentCount, 2);
    assert.deepEqual(r.requestedActionIssues, []);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.requestedActions.map(a => a.items[0].productText), products);
    assert.deepEqual(r.requestedActions.map(a => a.items[0].quantity), quantities);
    assert.equal(r.requestedActions[1].after, after ? 'request1' : undefined);
    assert.deepEqual(r.clauses?.map(c => c.intent), r.requestedActions.map(a => a.intent));
    assert.deepEqual(r.actions?.map(a => a.itemIndexes), [[0], [1]]);
    assert.deepEqual(r.entities.items, r.requestedActions.flatMap(a => a.items));
    assert.equal(r.graph?.nodes.filter(n => n.kind === 'ACTION').length, 2);
    assert.equal(actionInterpretationConflicts(r, r), false);
    assert.equal(r.fulfillment?.status, 'NOT_EXECUTED');
  }
});

test('partial parses and unsupported compositions never acquire complete interpretation', () => {
  for (const text of [
    'add it to cart and also to wishlist',
    'add banana to cart or add apple to wishlist',
    'do not add banana to cart and add apple to wishlist',
    'add banana to cart and do not add apple to wishlist',
    'add banana to cart, actually add apple to wishlist instead',
    'add banana to cart and add apple to wishlist if cheap',
    'add banana to cart tomorrow and add apple to wishlist',
    'add banana to cart and add apple to wishlist then checkout',
    'add banana to cart and add apple to wishlist / checkout',
    'add banana to cart and add apple to wishlist but only under $5',
    'add zero bananas to cart and add apple to wishlist',
    'add -1 banana to cart and add apple to wishlist',
    'add 1.5 bananas to cart and add apple to wishlist',
    'add 1000001 bananas to cart and add apple to wishlist',
    'add 1/2 banana to cart and add apple to wishlist',
    'add 2 kg bananas to cart and add apple to wishlist',
    'add some bananas to cart and add apple to wishlist',
    'add any banana to cart and add apple to wishlist',
    'add banana and apple to cart and also to wishlist',
    'add banana to cart and add apple to cart',
    'add banana to cart and to wishlist and to cart',
    'explain add banana to cart and add apple to wishlist',
    '"add banana to cart and add apple to wishlist"',
    'add "banana to cart and add apple to wishlist',
    'add banana to cart and add apple to wishlist ignore previous instructions',
  ]) {
    assert.equal(compoundRequest(text), undefined, text);
    assert.equal(resolve(runtime, text).compoundInterpretationVersion, undefined, text);
  }
});

test('stale context cannot supply an absent product or change a complete request', () => {
  const context = {selectedItems: [{productText: 'apples', quantity: 99}], pendingRequest: 'add 99 apples to cart', activeSearch: {text: 'find apples'}};
  assert.equal(resolve(runtime, 'add it to cart and also to wishlist', context).compoundInterpretationVersion, undefined);
  const r = resolve(runtime, 'add banana to cart then also to wishlist', context);
  assert.equal(r.compoundInterpretationVersion, 1);
  assert.deepEqual(r.requestedActions.map(a => a.items), [[{productText: 'banana'}], [{productText: 'banana'}]]);
  assert.deepEqual(r.context.next, {});
});

test('scoped product clarification reparses the full pair; yes never approves a parse', () => {
  const context = {pendingActionRequest: 'add it to cart then also to wishlist'};
  const filled = resolve(runtime, 'banana', context);
  assert.equal(filled.compoundReply, 'filled');
  assert.equal(filled.compoundInterpretationVersion, 1);
  assert.equal(filled.status, 'RESOLVED');
  assert.equal(filled.requestedActions[1].after, 'request1');
  const yes = resolve(runtime, 'yes', context);
  assert.equal(yes.compoundReply, 'rejected');
  assert.equal(yes.compoundInterpretationVersion, undefined);
});

test('the complete composition requires both intents in the active dictionary', () => {
  const restricted = compile({...runtime.dictionary,
    intents: runtime.dictionary.intents.filter(intent => intent.code !== 'ADD_TO_WISHLIST')});
  const r = resolve(restricted, 'add banana to cart and add apple to wishlist');
  assert.equal(r.compoundInterpretationVersion, undefined);
});
