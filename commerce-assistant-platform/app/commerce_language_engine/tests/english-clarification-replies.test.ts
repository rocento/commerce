import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {validContext} from '../src/context.ts';
import type {Context} from '../src/types.ts';

for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: a complete quantity answer replaces the unresolved original prefix`,()=>{
  for(const [original,answer,quantity] of [
   ['add 2 or 3 rings to my cart','3',3],
   ['add -2 rings to my cart','three',3],
   ['remove 0 rings from my cart','quantity 2 please',2],
   ['add 1.5 rings to my cart','a dozen',12],
  ] as const){
   const prior=resolve(c,original);
   assert.equal(prior.status,'NEEDS_CONTEXT',original);
   assert.equal(prior.context.next.pendingClarification?.slot,'quantity',original);
   assert.ok(validContext(prior.context.next,c.dictionary));
   const next=resolve(c,answer,prior.context.next);
   assert.equal(next.status,'RESOLVED',JSON.stringify(next));
   assert.equal(next.intent,prior.intent);assert.equal(next.entities.quantity,quantity);
   assert.equal(next.entities.quantityRange,undefined);
   assert.equal(next.entities.productText,'rings');assert.equal(next.clarificationReply,true);
   assert.ok(next.interpretationText);assert.equal(next.text,answer);
   assert.equal(next.context.next.pendingClarification,undefined);
   assert.equal(next.fulfillment?.status,'NOT_EXECUTED');
  }
 });
 test(`${name}: invalid, partial, orphan and forged quantity answers cannot authorize actions`,()=>{
  const prior=resolve(c,'add 2 or 3 rings to my cart');
  for(const answer of ['-3','0','1.5','1000001','3 or 4','3 and checkout','3 without silver','yes','three products and buy milk']){
   const next=resolve(c,answer,prior.context.next);
   assert.equal(next.status,'NEEDS_CONTEXT',answer);assert.equal(next.interpretationText,undefined,answer);
   assert.equal(next.operations?.length??0,0);assert.equal(next.context.next.pendingClarification?.text,prior.text);
  }
  assert.notEqual(resolve(c,'3').status,'RESOLVED');
  for(const text of ['add 2 rings to my cart','clear my cart','add 2 or 3 rings to my cart only if delivery is free']){
   const next=resolve(c,'3',{pendingClarification:{text,intent:'ADD_TO_CART',slot:'quantity'}});
   assert.equal(next.status,'NEEDS_CONTEXT',text);assert.equal(next.interpretationText,undefined);
   if(text.includes('only if'))assert.equal(next.entities.requestConstraints.length,1);
  }
  const fresh=resolve(c,'show my cart',prior.context.next);
  assert.equal(fresh.intent,'VIEW_CART');assert.equal(fresh.context.next.pendingClarification,undefined);
 });
 test(`${name}: product replies preserve quantity, destination and monetary requirements`,()=>{
  for(const [original,answer] of [['add two of it to my cart','Ruby Ring'],['find it between $50 and $100','Ruby Ring']] as const){
   const prior=resolve(c,original);
   assert.equal(prior.context.next.pendingClarification?.slot,'product',original);
   const next=resolve(c,answer,prior.context.next);
   assert.equal(next.status,'RESOLVED',JSON.stringify(next));assert.equal(next.intent,prior.intent);
   assert.equal(next.entities.productText,'ruby ring');
   if(original.startsWith('add')){assert.equal(next.entities.quantity,2);assert.equal(next.entities.destination,'cart');}
   else assert.deepEqual(next.entities.price,{operator:'BETWEEN',min:50,max:100,currency:'USD'});
  }
  const prior=resolve(c,'find it under $100');
  for(const answer of ['yes','no','ruby ring under $200','ruby ring and checkout','ruby ring without gold','3','2 Ruby Rings']){
   const next=resolve(c,answer,prior.context.next);assert.equal(next.status,'NEEDS_CONTEXT',answer);assert.equal(next.interpretationText,undefined,answer);
  }
 });
 test(`${name}: a currency answer fills only a currency-less complete search`,()=>{
  const context:Context={pendingClarification:{text:'find rings between 50 and 100',intent:'PRODUCT_SEARCH',slot:'currency'}};
  for(const [answer,currency] of [['USD','USD'],['egyptian pounds','EGP'],['in EUR','EUR']] as const){
   const next=resolve(c,answer,context);assert.equal(next.status,'RESOLVED',answer);
   assert.deepEqual(next.entities.price,{operator:'BETWEEN',min:50,max:100,currency});
   assert.equal(next.entities.category,'ring');assert.equal(next.clarificationReply,true);
   assert.equal(next.context.next.activeSearch?.text,next.interpretationText);
  }
  for(const answer of ['USD 500','dollars','EGP and checkout','yes','100','EGP unless out of stock'])assert.equal(resolve(c,answer,context).status,'NEEDS_CONTEXT',answer);
  for(const original of ['find rings under $100','add rings under 100 to my cart','find rings under 100 excluding silver','show cart']){
   const next=resolve(c,'EUR',{pendingClarification:{text:original,intent:'PRODUCT_SEARCH',slot:'currency'}});
   assert.equal(next.status,'NEEDS_CONTEXT',original);assert.equal(next.interpretationText,undefined);
  }
 });
 test(`${name}: bounded same-in refinements retain category, bounds, currency and exclusions`,()=>{
  for(const answer of ['same in silver','the same one in silver','do you have it in silver?','have you got that in silver?','only silver']){
   const prior=resolve(c,'find gold rings between $50 and $100');
   const next=resolve(c,answer,prior.context.next);
   assert.equal(next.status,'RESOLVED',JSON.stringify(next));assert.equal(next.entities.material,'silver');
   assert.equal(next.entities.category,'ring');assert.equal(next.entities.color,undefined);
   assert.deepEqual(next.entities.price,{operator:'BETWEEN',min:50,max:100,currency:'USD'});
   assert.equal(next.searchUpdate,true);assert.ok(validContext(next.context.next,c.dictionary));
  }
  const constrained=resolve(c,'find rings under EGP 100 excluding copper');
  const retained=resolve(c,'same in silver',constrained.context.next);
  assert.equal(retained.status,'NEEDS_CONTEXT');assert.equal(retained.entities.material,'silver');
  assert.deepEqual(retained.entities.requestConstraints.map((entry:{value:string})=>entry.value),['copper']);
  assert.equal(retained.entities.price.currency,'EGP');
  for(const answer of ['same in silver and checkout','same in silver or gold','same in silver without copper','same in 3']){
   const next=resolve(c,answer,resolve(c,'find rings under $100').context.next);
   assert.equal(next.status,'NEEDS_CONTEXT',answer);assert.equal(next.interpretationText,undefined,answer);
  }
  assert.equal(resolve(c,'same in silver').status,'NEEDS_CONTEXT');
  const interrupted=resolve(c,'hello',resolve(c,'find rings under $100').context.next);
  assert.equal(resolve(c,'same in silver',interrupted.context.next).status,'NEEDS_CONTEXT');
 });
 test(`${name}: pending clarification context is bounded linguistic data`,()=>{
  for(const pendingClarification of [{text:'',intent:'ADD_TO_CART',slot:'quantity'},{text:'find it',intent:'NO_ACTION',slot:'product'},{text:'find it',intent:'PRODUCT_SEARCH',slot:'product',productId:'forged'},{text:'find it',intent:'PRODUCT_SEARCH',slot:'confirmation'}])
   assert.equal(validContext({pendingClarification},c.dictionary),false);
 });
}
