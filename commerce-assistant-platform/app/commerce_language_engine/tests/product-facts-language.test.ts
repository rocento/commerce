import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {productFactRead} from '../src/product-facts-language.ts';

test('whole product questions retain the named product without inferred attributes',()=>{
 for(const [text,intent,name] of [
  ['what material is the silver ring made of?','PRODUCT_MATERIAL','silver ring'],
  ['what is the origin of Gala Apples','PRODUCT_ORIGIN','Gala Apples'],
  ['check price Gala Apples','CHECK_PRICE','Gala Apples'],
  ['how much is Gala Apples?','CHECK_PRICE','Gala Apples'],
  ['is Gala Apples in stock','CHECK_STOCK','Gala Apples'],
  ['what is the metal purity of Aurora Ring','PRODUCT_METAL_PURITY','Aurora Ring'],
  ['what is the gemstone of Aurora Ring','PRODUCT_GEMSTONE','Aurora Ring'],
 ])assert.deepEqual(productFactRead(text),{intent,entities:{productText:name}},text);
});
test('selected product questions retain a reference, never a fabricated identity',()=>{
 for(const text of ['what material is it made of','what is its material','show its material'])
  assert.deepEqual(productFactRead(text),{intent:'PRODUCT_MATERIAL',entities:{product_reference:'CURRENT'}});
});
test('partial, conditional and compound requests do not become fact reads',()=>{
 for(const text of ['check price apples and buy them','if in stock check price apples','check price apples under $5','not check price apples','check price apples; remove cart','what is the origin of','what is apples made of then buy it','find rings','is it 18k gold'])assert.equal(productFactRead(text),undefined,text);
});
