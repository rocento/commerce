import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildKnowledge} from '../src/knowledge.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';

for(const [name,build] of [['core',buildKnowledge],['expanded',buildExpandedDictionary]] as const){
 const compiled=compile(build());
 test(`${name}: explicit complaint requests resolve`,()=>{
  for(const text of ['pls handle complaint','file a complaint','raise a complaint about my order','lodge a complaint','register my complaint','i have a complaint','i want to complain','i would like to complain','complain about the delivery','i am complaining about the service']){
   const r=resolve(compiled,text);
   assert.equal(r.status,'RESOLVED',text);
   assert.equal(r.intent,'COMPLAINT',text);
  }
 });
 test(`${name}: denied or weak complaints do not resolve`,()=>{
  for(const text of ['do not file a complaint','do not handle my complaint','i do not want to complain','never complain about the delivery','i have no complaints','i have nothing to complain about','this is not a complaint','i am not complaining about the service','complaint']){
   assert.equal(resolve(compiled,text).intent,null,text);
  }
 });
 test(`${name}: other support actions keep their meaning`,()=>{
  for(const [text,intent] of [['contact support','CONTACT_SUPPORT'],['open a support ticket','CREATE_SUPPORT_REQUEST'],['create an order','CREATE_ORDER']])assert.equal(resolve(compiled,text).intent,intent,text);
 });
}

const expanded=compile(buildExpandedDictionary());
test('indirect problems and dissatisfaction with purchases imply complaints',()=>{
 for(const text of [
  'I have problem in my delivered order',
  'I have a problem with my delivered order',
  'There is an issue with the package I received',
  'I am having problems with my delivery',
  'Something is wrong with my order',
  'I am not happy with my purchase',
  "I'm disappointed with the customer service",
  'I am dissatisfied with the product',
  'My order has an issue',
  'The problem with my delivery is not resolved',
 ]){
  const result=resolve(expanded,text);
  assert.equal(result.status,'RESOLVED',text);
  assert.equal(result.intent,'COMPLAINT',text);
 }
});
test('indirect complaints require an unresolved commerce problem',()=>{
 for(const text of [
  'I have a problem with my homework',
  'My order was delivered',
  'I have no problem with my delivered order',
  "I don't have a problem with my order",
  'There are no issues with my delivery',
  'Nothing is wrong with my order',
  'I am not disappointed with my purchase',
  'The problem with my delivery is resolved',
  'The issue with my order was fixed',
  'You resolved my problem with the delivery',
  'Write a story about a problem with a delivered order',
  'What if I have a problem with my order',
  'I have a problem with homework and need help solving the difficult algebra exercise before I check my order',
 ])assert.equal(resolve(expanded,text).intent,null,text);
});
test('specific order problems retain their specialized intents',()=>{
 for(const [text,intent] of [
  ['I have a problem with my order it arrived damaged','ORDER_DAMAGED'],
  ['There is an issue with my order I received the wrong item','ORDER_WRONG_ITEM'],
 ])assert.equal(resolve(expanded,text).intent,intent,text);
});
