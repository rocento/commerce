import './recognition-test-context.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearComparisonRequested } from '../src/comparison-language.ts';
import { loadRuntime } from '../src/runtime.ts';
import { compile } from '../src/compiler.ts';
import { buildExpandedDictionary } from '../src/generation/dictionary.ts';
import { resolve } from '../src/engine.ts';

const commands = [
  'remove all compare list', 'remove all from compare', 'remove all products from my comparison list',
  'remove everything from comparison', 'remove every item from the comparison tray',
  'delete all items from my compare list', 'delete all comparison products',
  'clear my comparison list', 'clear compare', 'clear all comparisons',
  'clear out my comparison selection', 'empty the compare list', 'empty out this comparison list',
  'reset my comparison', 'reset the comparison tray', 'wipe my comparison list',
  'wipe out the comparison list', 'erase the comparison list',
  'get rid of everything in my compare list', 'take out all products from my comparison list',
  'deselect all products in comparison', 'unselect everything from the compare list',
  'remove all compared products', 'clear all my compared items',
  'start my comparison over', 'start comparison from scratch', 'start a fresh comparison',
  'clear my comparision list', 'empty the comparsion list',
];
const protectedMessages = [
  "don't clear my comparison list", 'do not remove all compare list', 'never empty comparison',
  'keep my comparison list', 'I do not want to reset my comparison',
  'clear comparison except Gala', 'remove all but tea from comparison',
  'clear comparison if the products are unavailable', 'clear comparison unless milk is in it',
  'clear comparison and clear cart', 'empty comparison then add milk', 'clear comparison; buy tea',
  'clear comparison\nremove milk', 'clear comparison or wishlist',
  'remove Gala from comparison', 'remove the first item from comparison', 'remove 2 from compare',
  'remove some products from comparison', 'clear cart', 'empty my wishlist',
  'compare tea and coffee', 'show my comparison list', 'how do I clear the comparison list',
  'what happens if I clear comparison', 'can I clear comparison',
  '"clear comparison list"', "'clear comparison list'", 'find Clear Comparison List',
  'add comparison list notebook to cart', 'clear', 'remove all', 'start a new order',
];
test('supports bounded courteous phrasing and retains safeguards', () => {
  for (const message of commands) for (const prefix of ['', 'pls ', 'Please ', 'Could you please ', 'I want to ', 'I would like you to ', 'Hey, can you ', "I'd like to "])
    for (const suffix of ['', ' please', ' for me', ' now!']) assert.equal(clearComparisonRequested(prefix + message + suffix), true, prefix + message + suffix);
  for (const message of protectedMessages) assert.equal(clearComparisonRequested(message), false, message);
});
for (const [name, runtime] of [['packaged', await loadRuntime()], ['generated', compile(buildExpandedDictionary())]] as const) {
  test(`${name}: comparison clear connects a distinct intent without cart/product operations`, () => {
    for (const text of commands) {
      const result = resolve(runtime, text);
      assert.equal(result.status, 'RESOLVED', text);
      assert.equal(result.intent, 'CLEAR_COMPARISON', text);
      assert.deepEqual(result.entities, {}, text);
      assert.deepEqual(result.operations, [], text);
      assert.equal(result.text, text);
      assert.equal(result.fulfillment?.status, 'NOT_EXECUTED');
    }
    for (const text of protectedMessages) assert.notEqual(resolve(runtime, text).intent, 'CLEAR_COMPARISON', text);
    assert.equal(resolve(runtime, 'clear cart').intent, 'CLEAR_CART');
    assert.equal(resolve(runtime, 'compare tea and coffee').intent, 'PRODUCT_COMPARE');
  });
}
