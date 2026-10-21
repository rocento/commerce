import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {loadRuntime} from '../src/runtime.ts';
import {wishlistReadRequested} from '../src/wishlist-read-language.ts';

// Independently written holdouts: these do not come from the generated corpus.
const holdouts = [
  "Where's my wishlist?",
  'Where can I see my saved products?',
  'How do I get to my favorites?',
  'How can I open my wish list?',
  'Can you pull up my saved items?',
  'Could you take me to my favourites?',
  "I'd like to look at my wish list.",
  'I need to check my saved products.',
  'What have I saved for later?',
  'Which products are in my wishlist?',
  'What is currently on my favourites?',
  'Show me the products I saved.',
  'Let me view my wishlist.',
  'Can I see my favourites?',
  'Please bring up my saved products.',
  'Help me find my wishlist.',
  'I want to see my wish list, please.',
  'Tell me what I have on my wishlist.',
  'Is anything in my saved items?',
  'Do I have any saved products?',
  'What have I favorited?',
  'What have I favourited?',
];

const protectedRequests: Record<string, string[]> = {
  'writes and instructions about writes': [
    'save milk for later',
    'add milk to my wishlist',
    'remove milk from my wishlist',
    'empty my saved items',
    'move my wishlist to my cart',
    'copy my saved items to my cart',
    'how do I save milk to my wishlist?',
    'how can I add products to my favorites?',
    'show me how to remove products from my wishlist',
    'where do I click to delete my wishlist?',
    'how do I create a wishlist?',
    'what happens if I clear my saved items?',
    'can I move items from my wishlist to my cart?',
  ],
  'mixed reads and other requests': [
    'where is my wishlist and add milk to my cart',
    'show my wishlist then clear my cart',
    'open my wishlist or my cart',
    'show my wishlist and my orders',
    'show me my wishlist, buy bread',
    'show my wishlist. Delete everything from it.',
    'where is my wishlist? Cancel order 42.',
    'where is my wishlist; empty my cart',
    'show my saved items\nremove milk from my cart',
    'show my saved items\rdelete milk',
    'show my wishlist / checkout',
    'show my wishlist \\ add milk',
    'show my wishlist | add milk',
    'show my wishlist & buy milk',
    'show my wishlist: delete everything',
    'show my wishlist, just kidding',
  ],
  'negation, conditions and restricted subsets': [
    'do not show my wishlist',
    "don't open my wishlist",
    'never display my saved items',
    "I don't want to see my favorites",
    'show my wishlist if I have saved anything',
    'where is my wishlist unless it is empty',
    'show my wishlist without opening it',
    'show my wishlist except milk',
    'show only the discounted products in my wishlist',
    'show my saved items under $10',
    'show the first product in my wishlist',
    'show my wishlist after checkout',
    'show my wishlist tomorrow',
    'show my wishlist instead of my cart',
  ],
  'other people and other collections': [
    "where is John's wishlist?",
    "show my sister's favorites",
    'where is her wishlist?',
    'how do I open your wishlist?',
    'show their saved products',
    "show someone else's saved items",
    'where is the wishlist of another customer?',
    'where are my saved addresses?',
    'where is my shopping cart?',
    'how do I see my order history?',
    'show me my favorites from another account',
  ],
  'product names and quoted or embedded language': [
    'where is my Wishlist Notebook?',
    'show me Favorites perfume',
    'find saved items storage boxes',
    'add Wishlist Notebook to my cart',
    'where is my wish list notebook?',
    'show "my wishlist"',
    '"where is my wishlist"',
    "'show my wishlist'",
    '‘show my wishlist’',
    '`show my wishlist`',
    'translate where is my wishlist',
    'explain the phrase where is my wishlist',
    'pretend I said show my wishlist',
    '<show my wishlist>',
    'show my wishlist\0',
  ],
};

test('wishlist read grammar recognizes independently written access and content questions', () => {
  for (const text of holdouts) assert.equal(wishlistReadRequested(text), true, text);
});

for (const [name, requests] of Object.entries(protectedRequests)) {
  test(`wishlist read grammar rejects ${name}`, () => {
    for (const text of requests) assert.equal(wishlistReadRequested(text), false, text);
  });
}

for (const [name, runtime] of [
  ['generated vocabulary', compile(buildExpandedDictionary())],
  ['packaged runtime', await loadRuntime()],
] as const) {
  test(`${name}: independent wishlist holdouts resolve to the direct read contract`, () => {
    for (const text of holdouts) {
      const result = resolve(runtime, text);
      assert.equal(result.status, 'RESOLVED', text);
      assert.equal(result.intent, 'VIEW_WISHLIST', text);
      assert.equal(result.text, text, text);
      assert.deepEqual(result.entities, {}, text);
      assert.equal(result.requiresConfirmation, false, text);
      assert.equal(result.requestType, undefined, text);
      assert.equal(result.intentCount, 1, text);
      assert.equal(result.requestedActions?.length, 1, text);
      assert.equal(result.requestedActions?.[0].intent, 'VIEW_WISHLIST', text);
    }
  });

  test(`${name}: wishlist reads supersede pending products, delivery addresses and compound additions`, () => {
    const cartRequest = resolve(runtime, 'pls add two product to cart');
    assert.equal(cartRequest.status, 'NEEDS_CONTEXT');
    assert.equal(cartRequest.context.next.pendingClarification?.slot, 'product');
    const orderRequest = resolve(runtime, 'create an order for two apples and deliver it there');
    assert.equal(orderRequest.status, 'NEEDS_CONTEXT');
    assert.ok(orderRequest.context.next.pendingRequest);
    const compoundText = 'add 2 of it to cart then also to wishlist';
    assert.deepEqual(resolve(runtime, compoundText).requestedActions.map(action => action.intent), [
      'ADD_TO_CART', 'ADD_TO_WISHLIST',
    ]);
    const contexts = [
      cartRequest.context.next,
      orderRequest.context.next,
      {pendingActionRequest: compoundText},
    ];
    const reads = [...holdouts, 'my wishlist', 'open my wishlist', "I can't find my wishlist"];
    for (const context of contexts) for (const text of reads) {
      const result = resolve(runtime, text, context);
      assert.equal(result.status, 'RESOLVED', text);
      assert.equal(result.intent, 'VIEW_WISHLIST', text);
      assert.equal(result.text, text, text);
      assert.deepEqual(result.entities, {}, text);
      assert.equal(result.requiresConfirmation, false, text);
      assert.equal(result.requestType, undefined, text);
      assert.deepEqual(result.operations ?? [], [], text);
      assert.deepEqual(result.actions ?? [], [], text);
      assert.equal(result.intentCountStatus, 'EXACT', text);
      assert.deepEqual(result.requestedActions.map(action => action.intent), ['VIEW_WISHLIST'], text);
      assert.deepEqual(result.context.input, context, text);
      assert.equal(result.context.next.pendingRequest, undefined, text);
      assert.equal(result.context.next.pendingClarification, undefined, text);
      assert.equal(result.context.next.pendingActionRequest, undefined, text);
    }
  });
}
