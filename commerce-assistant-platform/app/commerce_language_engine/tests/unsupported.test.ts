import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {unsupportedIntents} from '../src/unsupported.ts';
const runtime=compile(buildExpandedDictionary());

test('recognizes unsupported capabilities without restoring executable intents',()=>{
 for(const [text,code] of [['please redeem my gift card','APPLY_GIFT_CARD'],['cancel my subscription','CANCEL_SUBSCRIPTION'],['return my order','RETURN_ORDER'],['redeem points','REDEEM_POINTS'],['add payment card','PAYMENT_CARD_ADD'],['place preorder','CREATE_PREORDER']]){
  const result=resolve(runtime,text,{pendingRequest:'add items to cart'});
  assert.equal(result.status,'UNSUPPORTED',text);
  assert.equal(result.reason,'unsupported_capability');
  assert.ok(result.unsupportedIntents?.includes(code));
  assert.equal(result.intent,null);
  assert.deepEqual(result.actions,[]);
  assert.deepEqual(result.operations,[]);
  assert.equal(result.requiresConfirmation,false);
  assert.equal(result.context.next.pendingRequest,undefined);
  assert.ok(!runtime.dictionary.intents.some(intent=>intent.code===code));
 }
});

test('mixed requests never return the executable supported portion',()=>{
 const result=resolve(runtime,'add two apples to cart and apply gift card');
 assert.equal(result.status,'UNSUPPORTED');
 assert.deepEqual(result.entities,{});
 assert.deepEqual(result.operations,[]);
 assert.deepEqual(result.actions,[]);
 assert.match(result.message,/separately/);
});

test('mentions, negation, uncertainty and instructions are not unsupported commands',()=>{
 for(const text of ['find a gift card holder','show return policy','do not apply gift card','never cancel my subscription','how do I apply gift card','apply gift card or coupon','write a story about cancel subscription','purple elephants'])assert.deepEqual(unsupportedIntents(text),[],text);
 assert.equal(resolve(runtime,'purple elephants').status,'UNKNOWN');
 assert.equal(resolve(runtime,'show return policy').intent,'RETURN_POLICY');
 assert.notEqual(resolve(runtime,'show my orders').status,'UNSUPPORTED');
});
