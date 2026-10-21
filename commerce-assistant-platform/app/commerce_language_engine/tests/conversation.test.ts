import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {conversationIntent} from '../src/conversation.ts';

for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: explicit jokes and pretend commands cannot execute shopping`,()=>{
  for(const text of ['add apples to my cart just kidding','clear my cart lol just kidding',
   'cancel order 42, I am joking','pretend you added apples to my cart','tell me a joke']){
   const r=resolve(c,text,{pendingRequest:'add apples to cart',previousIntent:'ADD_TO_CART'});
   assert.equal(r.status,'RESOLVED',text);
   assert.equal(r.intent,'CONVERSATION_JOKE',text);
   assert.deepEqual(r.operations,[],text);
   assert.deepEqual(r.entities,{},text);
   assert.equal(r.requiresConfirmation,false,text);
   assert.equal(r.context.next.pendingRequest,undefined,text);
  }
 });
 test(`${name}: quoted product names remain searchable`,()=>{
  const r=resolve(c,'find "Just Kidding"');
  assert.equal(r.intent,'PRODUCT_SEARCH');
  assert.equal(r.entities.productText,'just kidding');
 });
}
test('tone and literal product words do not imply joking',()=>{
 for(const text of ['please add apples to cart','this is annoying, show my cart','find joke books',
  'find "Just Kidding"','find \'Just Joking\'','I am not joking, show my cart']){
  assert.equal(conversationIntent(text),undefined,text);
 }
});
