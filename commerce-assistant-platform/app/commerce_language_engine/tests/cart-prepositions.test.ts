import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
const compiled=await loadRuntime();
test('informal on-cart requests preserve product and quantity',()=>{
 for(const prep of ['to','into','in','on']){
  const r=resolve(compiled,`pls add 2 tea ${prep} cart`);
  assert.equal(r.status,'RESOLVED');assert.equal(r.intent,'ADD_TO_CART');
  assert.equal(r.entities.productText,'tea');assert.equal(r.entities.quantity,2);
 }
 for(const text of ['do not add tea on cart','add -7 tea on cart','add 1.5 tea on cart'])assert.notEqual(resolve(compiled,text).status,'RESOLVED',text);
});
