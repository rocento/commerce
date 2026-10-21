import './recognition-test-context.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
const compiled=await loadRuntime();
test('generic product browse accepts explicit merchant criteria',()=>{
 for(const [text,fields] of [
  ['find products, care area: face, texture: gel',[{name:'care area',value:'face'},{name:'texture',value:'gel'}]],
  ['find products, pack weight g: 500',[{name:'pack weight g',value:'500'}]],
  ['find products, RAM GB: 8',[{name:'ram gb',value:'8'}]],
 ] as const){
  const r=resolve(compiled,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_SEARCH');
  assert.deepEqual(r.entities.merchantAttributes,fields);assert.equal(r.entities.productText,'products');
 }
});
test('generic browse cannot swallow exclusions, conflicts or writes',()=>{
 for(const text of ['find products','find products, texture: gel and checkout','find products, texture: gel, texture: cream','add products to cart, texture: gel','find products, texture: gel without perfume']){
  const r=resolve(compiled,text);assert.notEqual(r.status,'RESOLVED',text);
 }
});
