import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {recommendationRequest} from '../src/recommendation-language.ts';
const runtime=await loadRuntime();
test('bare shopping desires resolve before the model fallback',()=>{
 for(const text of ['I want apple','I want apples','I want an apple','We want milk','I want apples under $20']){
  const r=resolve(runtime,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_SEARCH',text);assert.equal(r.text,text);assert.equal(r.requestType,undefined);
  assert.match(r.entities.productText,/apple|milk/i);
 }
 for(const meal of ['dinner','breakfast','lunch']){
  const text=`I want ${meal}`;const r=resolve(runtime,text);
  assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_RECOMMEND',text);assert.equal(r.entities.catalogPurpose,meal);assert.equal(r.text,text);assert.equal(r.requestType,undefined);
 }
});
test('bare desire discovery does not consume service requests or write commands',()=>{
 for(const text of ['I want to add apple','I want two apples','I want apple and milk','I want apple without sugar','I want support','I want a refund','I want my cart','I want a joke','I want apple; checkout']){
  assert.equal(recommendationRequest(runtime.dictionary,text),undefined,text);
 }
});
test('conversational recommendations preserve original text and read-only intent',()=>{
 for(const text of ['Could you please recommend milk under $20?','Any suggestions for rings under $50?','Help me choose products with material silver']){
  const r=resolve(runtime,text);assert.equal(r.status,'RESOLVED',text);assert.ok(['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(r.intent!));assert.equal(r.text,text);assert.equal(r.requestType,undefined);
 }
});
test('normalization preserves compound commands, negations and quoted names',()=>{
 for(const text of ['recommend milk and add it to cart','recommend tea unless it costs more than $10','recommend "Dinner Ring"','do not recommend milk','recommend milk; checkout','recommend milk or eggs'])assert.equal(recommendationRequest(runtime.dictionary,text),undefined,text);
});
test('medical claims retain literal evidence through normalization',()=>{
 const text='Could you recommend milk guaranteed to cure diabetes?';const r=resolve(runtime,text);
 const requirement=r.entities.evidenceRequirements?.find((item:any)=>item.kind==='medical_treatment');assert.ok(requirement);
 assert.equal([...text].slice(requirement.start,requirement.end).join(''),requirement.text);
});
