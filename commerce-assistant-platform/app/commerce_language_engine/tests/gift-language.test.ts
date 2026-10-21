import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {giftSearch} from '../src/gift-language.ts';
const runtime=await loadRuntime();
test('gift requests preserve recipient, occasion, product and price across stores',()=>{
 for(const [text,occasion,recipient] of [
  ['I need something for gift',undefined,undefined],
  ['I need gift for weeding','wedding',undefined],
  ['I need gift to my son',undefined,'my son'],
  ['I want a birthday present for my daughter','birthday','my daughter'],
  ["I need a gift for my son's birthday",'birthday','my son'],
  ['recommend a wedding gift under $100','wedding',undefined],
  ['I need silver rings as a gift for my wife',undefined,'my wife'],
  ['I need headphones as a gift for my son',undefined,'my son'],
  ['I need chocolates as a gift for my friend',undefined,'my friend'],
  ['I need skincare as a gift for my mother',undefined,'my mother'],
 ] as const){
  const r=resolve(runtime,text);assert.equal(r.status,'RESOLVED',text);assert.ok(['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(r.intent!),text);
  assert.equal(r.entities.giftContext?.occasion,occasion,text);assert.equal(r.entities.giftContext?.recipient,recipient,text);
  assert.equal(r.entities.catalogPurpose,undefined,text);
  if(text.includes('$100'))assert.equal(r.entities.price.value,100);
  if(text.includes('silver'))assert.match(r.entities.productText,/silver rings/);
 }
});
test('gift extraction never discards extra constraints, actions or quoted names',()=>{
 for(const text of ['I need a gift for my son and checkout','I need a gift without nuts','I need a gift for my son with diabetes','I need a gift for my son under $20 and add it','find "The Gift"','I do not want a gift','I need a gift safe for a baby'])assert.equal(giftSearch(text),undefined,text);
});
