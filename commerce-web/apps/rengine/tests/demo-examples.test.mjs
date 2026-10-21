import test from 'node:test';
import assert from 'node:assert/strict';
import {demoExamples,demoSuite,refreshExample} from '../public/demo-examples.js';

test('all demo budgets use the live store currency, without a guessed fallback',()=>{
 for(const store of ['grocery','jewelry','electronics','pharmacy']) {
  for(const currency of ['USD','EGP','SAR']) {
   const examples=demoExamples(store,currency).join('\n');
   assert.match(examples,new RegExp(`under \\d+ ${currency}`));
   assert.match(demoSuite(store,currency),new RegExp(`under \\d+ ${currency}`));
  }
  for(const currency of [null,undefined,'','invalid'])assert.doesNotMatch(demoExamples(store,currency).join('\n'),/under/);
 }
});

test('refreshing currency or store preserves a custom shopper request',()=>{
 const previous=demoExamples('grocery','USD'),next=demoExamples('grocery','EGP')[0];
 assert.equal(refreshExample(previous[0],previous,next),next);
 assert.equal(refreshExample('Find fruit under 75 SAR',previous,next),'Find fruit under 75 SAR');
});
