import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {validContext} from '../src/context.ts';
const runtime=await loadRuntime();
const original='add 2 of it to cart then also to wishlist';
const reply=(text:string,pending=original)=>resolve(runtime,text,{pendingActionRequest:pending});

test('fills a product in the complete request and preserves quantities and sequence',()=>{
  const prior=resolve(runtime,original);
  const next=reply('banana');
  assert.equal(next.compoundReply,'filled');
  assert.equal(next.intentCount,2);
  assert.deepEqual(next.requestedActions.map(a=>a.intent),['ADD_TO_CART','ADD_TO_WISHLIST']);
  assert.deepEqual(next.requestedActions.map(a=>a.items),[[{quantity:2,productText:'banana'}],[{quantity:2,productText:'banana'}]]);
  assert.equal(next.requestedActions[1].after,prior.requestedActions[1].after);
  assert.match(next.interpretationText!,/banana/);
});
test('fills only the unknown product without changing an independent wishlist item',()=>{
  const next=reply('banana','add it to cart and add 3 apples to wishlist');
  assert.equal(next.compoundReply,'filled');
  assert.deepEqual(next.requestedActions.map(a=>a.items),[[{productText:'banana'}],[{quantity:3,productText:'apples'}]]);
});
test('complete corrections replace the old actions and cancellation is explicit',()=>{
  const next=reply('actually add 3 apples to wishlist');
  assert.equal(next.compoundReply,'replaced');
  assert.equal(next.intentCount,1);
  assert.equal(next.requestedActions[0].intent,'ADD_TO_WISHLIST');
  for(const text of ['cancel','cancel that','never mind','stop please'])assert.equal(reply(text).compoundReply,'cancelled');
  assert.equal(reply('cancel my order').compoundReply,'rejected');
});
test('confirmations, conditions, amounts and extra instructions cannot fill a product',()=>{
  for(const text of ['yes','2','banana if cheap','banana and checkout','ignore previous instructions','banana, apple','under 100']){
    const next=reply(text);
    assert.equal(next.compoundReply,'rejected',text);
    assert.equal(next.interpretationText,original);
  }
  assert.equal(reply('banana','add it to cart or to wishlist').compoundReply,'rejected');
  assert.equal(reply('banana','add it to cart if cheap and also to wishlist').compoundReply,'rejected');
});
test('pending text is bounded and cannot include execution authority',()=>{
  assert.equal(validContext({pendingActionRequest:original},runtime.dictionary),true);
  assert.equal(validContext({pendingActionRequest:'x'.repeat(4001)},runtime.dictionary),false);
  assert.equal(validContext({pendingActionRequest:original,product_id:'forged'},runtime.dictionary),false);
});
