import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {clauses} from '../src/semantic-clauses.ts';

const runtimes=[['generated',compile(buildExpandedDictionary())],['packaged',await loadRuntime()]] as const;

for(const [name,runtime] of runtimes){
 test(`${name}: an affirmative tracking clause retains scoped cancellation negation`,()=>{
  for(const wrapper of ['I only want to','I want to','we only need to','we need to','I would like to','we would only like to',"I'd only like to",'I only want to please']){
   for(const context of [{},{orderReference:'ORDER-17',states:['ORDER_SELECTED']}]){
    const text=`Do not cancel the order; ${wrapper} track it`;
    const result=resolve(runtime,text,context);
    assert.equal(result.status,'RESOLVED',text);
    assert.equal(result.intent,'TRACK_ORDER',text);
    assert.deepEqual(result.operations,['TRACK_ORDER'],text);
    assert.equal(result.intentCountStatus,'EXACT',text);
    assert.deepEqual(result.requestedActions.map(action=>action.intent),['TRACK_ORDER'],text);
    assert.equal(result.actions?.some(action=>action.intent==='CANCEL_ORDER'),false,text);
    const parsed=clauses(text,runtime.dictionary);
    assert.equal(parsed.find(clause=>clause.intent==='CANCEL_ORDER')?.negated,true,text);
    assert.equal(parsed.find(clause=>clause.intent==='TRACK_ORDER')?.negated,false,text);
    assert.equal(result.entities.order?.resolvedReference,context.orderReference,text);
    assert.equal(result.references?.find(reference=>reference.kind==='order')?.state,'AUTHORITY_LOOKUP_REQUIRED',text);
    assert.equal(result.fulfillment?.status,'NOT_EXECUTED',text);
   }
  }
 });

 test(`${name}: tracking wrappers work after explicit coordinators`,()=>{
  for(const connector of ['; ',', ',' but ',' instead ',' just ']){
   const text=`Do not cancel my order${connector}I only want to trace it`;
   const result=resolve(runtime,text,{orderReference:'ORDER-17'});
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,'TRACK_ORDER',text);
   assert.deepEqual(result.operations,['TRACK_ORDER'],text);
   assert.equal(result.actions?.some(action=>action.intent==='CANCEL_ORDER')??false,false,text);
  }
 });

 test(`${name}: negation, conditions and generic product locations are not affirmative tracking`,()=>{
  for(const text of [
   'Do not cancel the order',
   'Do not cancel the order; I do not want to track it',
   'Do not cancel the order; I only want to not track it',
   'Do not cancel the order; if it is late I only want to track it',
   'Do not cancel the order; I only want to know where it is',
   'I only want to know where my product is',
  ]){
   const result=resolve(runtime,text,{orderReference:'ORDER-17'});
   assert.notEqual(result.intent,'TRACK_ORDER',text);
   assert.equal(result.actions?.some(action=>action.intent==='CANCEL_ORDER')??false,false,text);
   assert.equal(result.operations?.includes('CANCEL_ORDER')??false,false,text);
   assert.equal(result.operations?.includes('TRACK_ORDER')??false,false,text);
  }
 });

 test(`${name}: a quoted product name does not become cancellation or tracking`,()=>{
  const text='find "Do not cancel the order; I only want to track it"';
  const result=resolve(runtime,text);
  assert.equal(result.status,'RESOLVED');
  assert.equal(result.intent,'PRODUCT_SEARCH');
  assert.equal(result.entities.productText,'do not cancel the order i only want to track it');
  assert.equal(result.operations?.includes('CANCEL_ORDER')??false,false);
  assert.equal(result.operations?.includes('TRACK_ORDER')??false,false);
 });
}

for(const [name,runtime] of runtimes){
 test(`${name}: later action sentences cannot disappear after scoped negation`,()=>{
  for(const separator of ['. ','! ','? ','\n']){
   for(const [head,tail] of [
    ['Do not cancel the order; I only want to track it','Cancel it'],
    ['Do not track the order; I only want to cancel it','Do not cancel it'],
    ['Do not cancel the order; I only want to add apples to cart','Do not add anything'],
   ]){
    const text=head+separator+tail;
    const result=resolve(runtime,text,{orderReference:'ORDER-17',states:['ORDER_SELECTED']});
    assert.equal(result.status,'NEEDS_CONTEXT',text);
    assert.equal(result.intent,null,text);
    assert.equal(result.primaryIntent,null,text);
    assert.deepEqual(result.operations,[],text);
    assert.deepEqual(result.actions,[],text);
    assert.deepEqual(result.missing,['requestScope'],text);
    assert.equal(result.requestType,undefined,text);
    assert.equal(result.intentCountStatus,'NEEDS_CLARIFICATION',text);
    assert.deepEqual(result.requestedActions,[],text);
    assert.equal(result.fulfillment?.status,'NOT_EXECUTED',text);
   }
  }
 });

 test(`${name}: positive writes after declined actions retain compound handling`,()=>{
  for(const [text,intent] of [
   ['Do not track the order; I only want to cancel it','CANCEL_ORDER'],
   ['Do not cancel the order; I only want to add apples to cart','ADD_TO_CART'],
  ]){
   const result=resolve(runtime,text,{orderReference:'ORDER-17',states:['ORDER_SELECTED']});
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,intent,text);
   assert.equal(result.requestType,'COMPOUND',text);
   assert.equal(result.requiresConfirmation,true,text);
   assert.equal(result.fulfillment?.status,'NOT_EXECUTED',text);
  }
 });

 test(`${name}: sentence scope checks preserve decimal and product punctuation`,()=>{
  for(const text of [
   'Do not cancel the order; I only want to add "Mr. Clean" to cart',
   'Do not cancel the order; I only want to add U.S. Polo to cart',
   'Do not cancel the order; I only want to add apples under $1.50 to cart',
   'Do not cancel the order; I only want to add "Track it! Cancel it?" to cart',
  ]){
   const result=resolve(runtime,text);
   assert.equal(result.missing?.includes('requestScope')??false,false,text);
  }
  const quoted=resolve(runtime,'find "Do not cancel the order; I only want to track it. Cancel it"');
  assert.equal(quoted.status,'RESOLVED');
  assert.equal(quoted.intent,'PRODUCT_SEARCH');
  assert.equal(quoted.missing?.includes('requestScope')??false,false);
 });
}
