import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {withDictionaryRecognition} from '../src/recognition-rules.ts';
import {conflictingPriceBounds} from '../src/price-language.ts';
const dictionary=buildExpandedDictionary();
test('price intersections reject empty ranges using published comparison operators',()=>withDictionaryRecognition(dictionary,()=>{
 for(const text of ['headphones under $5 and over $100','headphones over $100 and under $5','laptops at least $50 and less than $50','laptops exactly $50 and over $50'])assert.equal(conflictingPriceBounds(text),true,text);
 for(const text of ['headphones over $5 and under $100','headphones at least $50 and at most $50','headphones under $5 or over $100','headphones under $5 and laptops over $100','headphones under $5 and over €100','headphones under $5'])assert.equal(conflictingPriceBounds(text),false,text);
}));

import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
test('a quoted product title owns its apparent price comparisons',()=>{
 const result=resolve(compile(dictionary),'Show me "Under $5 and Over $100"');
 assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'PRODUCT_SEARCH');
});
