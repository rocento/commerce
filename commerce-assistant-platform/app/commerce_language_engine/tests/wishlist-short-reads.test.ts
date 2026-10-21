import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {loadRuntime} from '../src/runtime.ts';
import {wishlistReadRequested} from '../src/wishlist-read-language.ts';

// Independently written shopper language: these are not generated corpus rows.
const shortReads = [
  'what are my saved items?',
  'what my saved products?',
  'which my saved products?',
  'where my wishlist?',
  'what in my wishlist?',
  'what I saved for later?',
  'what my favorites?',
  'show my saved products',
  'please open my saved items',
];

const ambiguousSavedReads = [
  'what my saved?',
  'what I saved?',
  'show me what I saved',
  'my saved?',
  'show my saved',
  'where my saved?',
  'where are my saved?',
  "where's my saved?",
  'what is my saved?',
  "what's my saved?",
  'what are my saved?',
  "what's in my saved?",
  'please open my saved',
];

const clarificationMessage = 'Which saved information would you like to see: your wishlist or your saved addresses?';

function assertSavedChoice(result: ReturnType<typeof resolve>, text: string, pendingRequest = text) {
  assert.equal(result.status, 'NEEDS_CONTEXT', text);
  assert.equal(result.intent, null, text);
  assert.equal(result.primaryIntent, null, text);
  assert.equal(result.message, clarificationMessage, text);
  assert.deepEqual(result.missing, ['savedCollection'], text);
  assert.equal(result.requiresConfirmation, false, text);
  assert.deepEqual(result.entities, {}, text);
  assert.deepEqual(result.requestedActions ?? [], [], text);
  assert.deepEqual(result.actions ?? [], [], text);
  assert.deepEqual(result.operations ?? [], [], text);
  assert.equal(result.context.next.pendingRequest, pendingRequest, text);
}

const protectedRequests = [
  'saved',
  'what is saved?',
  'what my saved addresses?',
  'where my saved cards?',
  'show my saved orders',
  'what are my saved payment methods?',
  'where are my saved searches?',
  'show her saved',
  'what their saved items?',
  "where my sister's saved products?",
  'show my saved from another account',
  'save my items',
  'remove my saved',
  'empty my saved items',
  'move my saved to my cart',
  'what my saved and add milk to cart',
  'show my saved then checkout',
  'what my saved? Delete everything.',
  'do not show my saved',
  "don't open my saved",
  'show only my saved discounted products',
  'show "my saved"',
  '"what my saved?"',
  "'what my saved?'",
  'translate what my saved',
  'what my Saved Notebook?',
  'show my saved items storage boxes',
];

test('short wishlist grammar recognizes incomplete shopper questions', () => {
  for (const text of shortReads) assert.equal(wishlistReadRequested(text), true, text);
});

test('short wishlist grammar preserves ownership, collection and single-request boundaries', () => {
  for (const text of [...ambiguousSavedReads, ...protectedRequests]) assert.equal(wishlistReadRequested(text), false, text);
});

for (const [name, runtime] of [
  ['generated vocabulary', compile(buildExpandedDictionary())],
  ['packaged runtime', await loadRuntime()],
] as const) {
  test(`${name}: short wishlist questions resolve to exactly one direct read`, () => {
    for (const text of shortReads) {
      const result = resolve(runtime, text);
      assert.equal(result.status, 'RESOLVED', text);
      assert.equal(result.intent, 'VIEW_WISHLIST', text);
      assert.equal(result.text, text, text);
      assert.equal(result.requiresConfirmation, false, text);
      assert.deepEqual(result.entities, {}, text);
      assert.equal(result.requestType, undefined, text);
      assert.equal(result.intentCount, 1, text);
      assert.equal(result.intentCountStatus, 'EXACT', text);
      assert.deepEqual(result.requestedActionIssues, [], text);
      assert.deepEqual(result.requestedActions.map(action => action.intent), ['VIEW_WISHLIST'], text);
      assert.deepEqual(result.actions ?? [], [], text);
      assert.deepEqual(result.operations ?? [], [], text);
    }
  });

  test(`${name}: short wishlist questions replace a pending cart-product clarification`, () => {
    const cartRequest = resolve(runtime, 'pls add two product to cart');
    assert.equal(cartRequest.status, 'NEEDS_CONTEXT');
    const context = cartRequest.context.next;
    assert.equal(context.pendingClarification?.slot, 'product');
    for (const text of shortReads) {
      const result = resolve(runtime, text, context);
      assert.equal(result.status, 'RESOLVED', text);
      assert.equal(result.intent, 'VIEW_WISHLIST', text);
      assert.equal(result.requiresConfirmation, false, text);
      assert.deepEqual(result.entities, {}, text);
      assert.deepEqual(result.requestedActions.map(action => action.intent), ['VIEW_WISHLIST'], text);
      assert.deepEqual(result.actions ?? [], [], text);
      assert.deepEqual(result.operations ?? [], [], text);
      assert.deepEqual(result.context.input, context, text);
      assert.equal(result.context.next.pendingRequest, undefined, text);
      assert.equal(result.context.next.pendingClarification, undefined, text);
      assert.equal(result.context.next.pendingActionRequest, undefined, text);
    }
  });

  test(`${name}: short wishlist routing does not hijack protected requests`, () => {
    for (const text of protectedRequests) {
      const result = resolve(runtime, text);
      assert.notEqual(result.intent, 'VIEW_WISHLIST', text);
      assert.equal(result.missing?.includes('savedCollection') ?? false, false, text);
    }
  });

  test(`${name}: generic saved questions ask which collection without requesting an action`, () => {
    for (const text of ambiguousSavedReads) assertSavedChoice(resolve(runtime, text), text);
  });

  test(`${name}: generic saved questions do not resume a previous cart write`, () => {
    const cartRequest = resolve(runtime, 'pls add two product to cart');
    assert.equal(cartRequest.status, 'NEEDS_CONTEXT');
    assert.equal(cartRequest.context.next.pendingClarification?.slot, 'product');
    const contexts = [
      {...cartRequest.context.next, timezone: 'Africa/Cairo'},
      {pendingActionRequest: 'add 2 of it to cart then also to wishlist', timezone: 'Africa/Cairo'},
    ];
    for (const context of contexts) for (const text of ambiguousSavedReads) {
      const result = resolve(runtime, text, context);
      assertSavedChoice(result, text);
      assert.deepEqual(result.context.input, context, text);
      assert.equal(result.context.next.timezone, context.timezone, text);
      assert.equal(result.context.next.pendingClarification, undefined, text);
      assert.equal(result.context.next.pendingActionRequest, undefined, text);
    }
  });

  test(`${name}: saved collection choices complete a direct read round trip`, () => {
    const original = "what's my saved?";
    const question = resolve(runtime, original);
    assertSavedChoice(question, original);
    for (const [reply, intent] of [
      ['wishlist', 'VIEW_WISHLIST'],
      ['saved addresses', 'ACCOUNT_ADDRESS_LIST'],
    ]) {
      const result = resolve(runtime, reply, question.context.next);
      assert.equal(result.status, 'RESOLVED', reply);
      assert.equal(result.intent, intent, reply);
      assert.equal(result.text, reply, reply);
      assert.equal(result.requiresConfirmation, false, reply);
      assert.deepEqual(result.entities, {}, reply);
      assert.deepEqual(result.requestedActions.map(action => action.intent), [intent], reply);
      assert.deepEqual(result.actions ?? [], [], reply);
      assert.deepEqual(result.operations ?? [], [], reply);
      assert.equal(result.context.next.pendingRequest, undefined, reply);
      assert.equal(result.context.next.pendingClarification, undefined, reply);
      assert.equal(result.context.next.pendingActionRequest, undefined, reply);
    }
  });

  test(`${name}: invalid saved choices preserve the question without producing writes`, () => {
    const original = 'what my saved?';
    const question = resolve(runtime, original);
    assertSavedChoice(question, original);
    for (const reply of [
      'milk',
      'save milk',
      'clear my wishlist',
      'add milk to cart',
      'her wishlist',
      "my sister's saved addresses",
      'wishlist and clear my cart',
      '"wishlist"',
    ]) {
      const result = resolve(runtime, reply, question.context.next);
      assertSavedChoice(result, reply, original);
      assert.deepEqual(result.context.input, question.context.next, reply);
    }
  });
}
