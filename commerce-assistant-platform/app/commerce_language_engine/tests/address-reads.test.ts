import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {commerceFragment} from '../src/commerce-fragments.ts';
const runtime=await loadRuntime();
test('address shortcut and typed reads resolve to the same read-only intent',()=>{
 for(const text of ['List my addresses','show my addresses','show my saved addresses','view my delivery addresses','show my addresses in chat']) {
  const r=resolve(runtime,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'ACCOUNT_ADDRESS_LIST',text);assert.equal(r.requiresConfirmation,false,text);
 }
});
test('address read paraphrases do not swallow writes, conditions or quoted requests',()=>{
 for(const text of ['delete my addresses','show my addresses and clear my cart','show my addresses if cart is empty','"show my addresses"','do not show my addresses','set my default address']) assert.equal(commerceFragment(runtime.dictionary,text),undefined,text);
});
