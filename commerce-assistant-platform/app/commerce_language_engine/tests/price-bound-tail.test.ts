import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
const compiled=await loadRuntime();

test('price conjunctions remain constraints of one product search',()=>{
 for(const text of ['find shoes above $100 and under $101','find shoes over £100 and at most £200','find shoes more than $10 and less than $50']){
  const r=resolve(compiled,text);
  assert.equal(r.status,'RESOLVED');assert.equal(r.intent,'PRODUCT_SEARCH');
  assert.equal(r.entities.productText,'shoes',text);assert.equal(r.entities.line_items,undefined,text);
 }
});
test('real item conjunctions and action boundaries remain present',()=>{
 const r=resolve(compiled,'find shoes and mugs');
 assert.equal(r.entities.items.length,2);
 const compound=resolve(compiled,'find shoes above $100 and under $200 then add them to cart');
 assert.ok(compound.operations?.includes('SEARCH_PRODUCTS'));
 assert.ok(compound.operations?.includes('ADD_ITEM'));
});
