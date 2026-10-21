import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {loadRuntime} from '../src/runtime.ts';

for (const [name, compiled] of [['generated', compile(buildExpandedDictionary())], ['packaged', await loadRuntime()]] as const) {
 test(`${name}: cheapest searches need no reference product`, () => {
  for (const text of ['pls i need cheapest dates', 'pls i need cheapest items', 'find cheapest dates']) {
   const result = resolve(compiled, text);
   assert.equal(result.status, 'RESOLVED', text);
   assert.equal(result.intent, 'PRODUCT_SEARCH', text);
   assert.equal(result.entities.sort_by, 'price_asc', text);
  }
 });
 test(`${name}: preserve negation and unbound result references`, () => {
  assert.equal(resolve(compiled, 'do not find cheapest dates').status, 'UNKNOWN');
  assert.equal(resolve(compiled, 'add the cheapest one to cart').status, 'NEEDS_CONTEXT');
 });
}

for (const [name, compiled] of [['generated', compile(buildExpandedDictionary())], ['packaged', await loadRuntime()]] as const) {
 test(`${name}: highest-price store requests select descending prices`,()=>{
  for(const text of ['what is highest item in store','pls recommend higest price item','show most expensive product']){
   const result=resolve(compiled,text);assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'PRODUCT_SEARCH');assert.equal(result.entities.sort_by,'price_desc');assert.equal(result.entities.productText,'products');
  }
  for(const text of ['do not show most expensive product','show most expensive product and add it to cart','show "most expensive product"'])assert.notEqual(resolve(compiled,text).entities.sort_by,'price_desc');
 });
}
