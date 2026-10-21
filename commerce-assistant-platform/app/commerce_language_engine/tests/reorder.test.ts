import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildKnowledge} from '../src/knowledge.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';

for(const [name,build] of [['core',buildKnowledge],['expanded',buildExpandedDictionary]] as const){
 const compiled=compile(build());
 test(`${name}: recreate spelling variants repeat an order`,()=>{
  for(const action of ['recreate','re create','re-create','reorder']){
   const text=`pls ${action} same last order`;
   const result=resolve(compiled,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,'REORDER',text);
  }
 });
 test(`${name}: recreation still requires affirmative order evidence`,()=>{
  for(const text of ['do not recreate my last order','never re create the last order','recreate my website','recreate']){
   assert.equal(resolve(compiled,text).status,'UNKNOWN',text);
  }
  assert.equal(resolve(compiled,'please create an order').intent,'CREATE_ORDER');
 });
}

for(const [name,build] of [['core',buildKnowledge],['expanded',buildExpandedDictionary]] as const){
 const compiled=compile(build());
 test(`${name}: numbered shorthand starts a reorder review`,()=>{
  for(const text of ['pls reorder #5','reorder 5','I need order same to number 5','repeat order number 5']){
   const result=resolve(compiled,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,'REORDER',text);
   assert.equal(result.entities.order.resolvedReference,'5',text);
  }
  for(const text of ['do not reorder #5','never repeat order 5']) assert.notEqual(resolve(compiled,text).intent,'REORDER',text);
 });
}
