import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {clearCartRequested} from '../src/cart-clear-language.ts';

const cases:Record<'commands'|'requests'|'protected'|'itemRemovals',string[]>=JSON.parse(readFileSync(new URL('./fixtures/cart-clear.json',import.meta.url),'utf8'));
test('whole-cart grammar supports removal, emptying, polite wrappers and cart destinations',()=>{
 for(const command of cases.commands)for(const prefix of ['', 'pls ', 'Please ', 'Could you please ', 'I want to ', "I'd like to "])
  for(const suffix of ['', ' please', ' for me now!', ', thank you'])assert.equal(clearCartRequested(prefix+command+suffix),true,prefix+command+suffix);
 for(const text of cases.requests)assert.equal(clearCartRequested(text),true,text);
 for(const text of [...cases.protected,...cases.itemRemovals])assert.equal(clearCartRequested(text),false,text);
});

for(const [name,runtime] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: complete whole-cart commands use the existing clear-cart contract`,()=>{
  for(const text of [...cases.commands,...cases.requests]){
   const result=resolve(runtime,text,{activeSearch:{text:'find milk under $5'},pendingRequest:'add two'});
   assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,'CLEAR_CART',text);
   assert.deepEqual(result.entities,{},text);assert.ok(result.requiresConfirmation,text);
   assert.equal(result.text,text);assert.equal(result.requestType,undefined,text);
   assert.equal(result.context.next.activeSearch,undefined,text);assert.equal(result.context.next.pendingRequest,undefined,text);
  }
 });
 test(`${name}: partial, qualified and informational messages cannot become an executable cart clear`,()=>{
  for(const text of [...cases.protected,...cases.itemRemovals]){
   const result=resolve(runtime,text);
   assert.ok(result.status!=='RESOLVED'||result.intent!=='CLEAR_CART'||!!result.requestType,text);
  }
  const conditional=resolve(runtime,'remove all products in cart except milk');
  assert.equal(conditional.status,'NEEDS_CONTEXT');assert.equal(conditional.entities.requestConstraints[0].value,'milk');
  assert.equal(resolve(runtime,'remove milk from cart').intent,'REMOVE_FROM_CART');
 });
}
