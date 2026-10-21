import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {canonicalRead} from '../src/read-language.ts';

for(const [name,runtime] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: service reads retain their meaning and agree with action counts`,()=>{
  for(const [text,intent] of [
   ['wishlist /','VIEW_WISHLIST'],['is pickup available','CHECK_PICKUP'],
   ['is delivery available','CHECK_DELIVERY'],['show rules for returns','RETURN_POLICY'],
   ['check material safety data sheet','SAFETY_DATA_SHEET'],['show price range','PRICE_RANGE'],
   ['check storage capacity','PRODUCT_STORAGE_CAPACITY'],['find nearest store','NEAREST_STORE'],
   ['find pickup locations','FIND_PICKUP_LOCATION'],['check ready for pickup','PICKUP_READY'],
  ]){
   const r=resolve(runtime,text);
   assert.equal(r.intent,intent,text);assert.equal(r.status,'RESOLVED',text);
   assert.equal(r.intentCountStatus,'EXACT',text);
   assert.deepEqual(r.requestedActions.map(action=>action.intent),[intent],text);
  }
 });
 test(`${name}: product references stay symbolic and slot replies preserve the flat contract`,()=>{
  const unknown=resolve(runtime,'where is this made');
  assert.equal(unknown.status,'NEEDS_CONTEXT');assert.deepEqual(unknown.entities,{product_reference:'CURRENT'});
  assert.deepEqual(unknown.missing,['productReference']);assert.equal(unknown.fulfillment?.needsClarification,true);
  const selected=resolve(runtime,'where is this made',{states:['PRODUCT_SELECTED']});
  assert.equal(selected.intent,'PRODUCT_ORIGIN');assert.equal(selected.status,'RESOLVED');
  const first=resolve(runtime,'pls add two product to cart');
  const reply=resolve(runtime,'fish',first.context.next);
  assert.equal(reply.status,'RESOLVED');assert.equal(reply.entities.productText,'fish');assert.equal(reply.entities.quantity,2);assert.equal(reply.entities.items,undefined);
  assert.equal(reply.requestedActions[0].intent,'ADD_TO_CART');
  const replaced=resolve(runtime,'show my cart',first.context.next);
  assert.equal(replaced.intent,'VIEW_CART');assert.equal(replaced.context.next.pendingClarification,undefined);
 });
 test(`${name}: read ownership cannot erase negation or following mutations`,()=>{
  for(const text of ['do not show rules for returns','show rules for returns then clear cart','is pickup available and add milk','check material safety data sheet; buy it']){
   const r=resolve(runtime,text);
   assert.equal(canonicalRead(text),undefined,text);
   assert.ok(!(r.status==='RESOLVED'&&r.intentCountStatus==='EXACT'&&['RETURN_POLICY','CHECK_PICKUP','SAFETY_DATA_SHEET'].includes(r.intent??'')),text);
  }
  assert.notEqual(resolve(runtime,'remove the punctuation from this sentence').intent,'PRODUCT_ACTION_CHOICE');
 });
}
