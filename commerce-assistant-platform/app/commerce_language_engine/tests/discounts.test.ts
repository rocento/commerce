import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: current generic discount recommendations`,()=>{
  for(const text of ['Recommend products with the best discounts today','show me products with the biggest discounts','find items with highest discounts now']){
   const r=resolve(c,text);assert.equal(r.status,'RESOLVED');assert.equal(r.intent,'PRODUCT_RECOMMEND');assert.equal(r.entities.discountRanking,true);assert.equal(r.requiresConfirmation,false);
  }
  for(const text of ['do not recommend products with best discounts today','recommend products with best discounts yesterday','recommend products with best discounts today then buy them','recommend tea with best discounts today','recommend products with best discounts today under $10'])assert.notEqual(resolve(c,text).entities.discountRanking,true,text);
 });
}
