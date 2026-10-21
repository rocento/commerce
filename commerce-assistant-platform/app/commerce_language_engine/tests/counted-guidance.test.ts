import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {countedProductGuidance} from '../src/product-guidance.ts';
const c=await loadRuntime();
test('counted shorthand creates separate selection requests, never a cart mutation',()=>{
 for(const text of ['add 5 lemons 2 breads','please add 5 lemons 2 breads to my cart']){
  const r=resolve(c,text);assert.equal(r.status,'NEEDS_CONTEXT');assert.equal(r.intent,'PRODUCT_ACTION_CHOICE');
  assert.deepEqual(r.entities.items,[{productText:'lemons',quantity:5},{productText:'breads',quantity:2}]);
  assert.equal(r.entities.guideAction,'cart');assert.deepEqual(r.actions,[]);
 }
 assert.deepEqual(countedProductGuidance('add 2 rings 3 necklaces'),[{productText:'rings',quantity:2},{productText:'necklaces',quantity:3}]);
});
test('ambiguous measurements, model numbers and clauses stay on the existing guarded path',()=>{
 for(const text of ['add 2 iphone 15 pro','add 5 lemons 2 kg','add 5 lemons 2 breads and checkout','do not add 5 lemons 2 breads','add 5 lemons 2 breads without nuts','add 1.5 lemons 2 breads','add 0 lemons 2 breads'])assert.equal(countedProductGuidance(text),undefined,text);
});
