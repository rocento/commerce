import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from '../src/engine.ts';
import {loadRuntime} from '../src/runtime.ts';
import {canonicalRead} from '../src/read-language.ts';
const runtime=await loadRuntime();
test('common offer questions use the verified discount recommendation path',()=>{
 for(const text of ['Any offers today?','What is on sale?','Show me deals','Find discounts now','Please show offers today']){
  const result=resolve(runtime,text);assert.equal(result.intent,'PRODUCT_RECOMMEND',text);assert.equal(result.entities.discountRanking,true,text);
 }
});
test('offer aliases do not discard product constraints or action clauses',()=>{
 for(const text of ['show deals under $5','show offers and clear my cart','do not show offers','find discounts for milk','any offers today; add milk'])assert.equal(canonicalRead(text),undefined,text);
});
