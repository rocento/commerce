import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {validContext} from '../src/context.ts';
const c=await loadRuntime();

test('order creation binds products and delivery to ordered preparation operations',()=>{
 const r=resolve(c,'create order for two apples and deliver to my home address');
 assert.equal(r.status,'RESOLVED');assert.equal(r.primaryIntent,'CREATE_ORDER');
 assert.deepEqual(r.entities.items,[{productText:'apples',quantity:2}]);
 assert.equal(r.entities.delivery.addressReference,'HOME');
 assert.deepEqual(r.operations,['ADD_ITEM','SET_DELIVERY_ADDRESS','CREATE_ORDER']);
 assert.equal(r.fulfillment?.status,'NOT_EXECUTED');assert.equal(r.requiresConfirmation,true);
 assert.ok(r.relationships?.some(e=>e.relation==='modifies'));
});
test('action boundaries differ from item list boundaries and quantities stay bound',()=>{
 const r=resolve(c,'add two apples and one milk then checkout');
 assert.equal(r.status,'RESOLVED');assert.equal(r.primaryIntent,'START_CHECKOUT');
 assert.equal(r.clauses?.length,2);assert.deepEqual(r.entities.items.map((i:any)=>[i.productText,i.quantity]),[['apples',2],['milk',1]]);
 assert.deepEqual(r.actions?.[0].itemIndexes,[0,1]);
});
test('generic quantities and novel product phrases do not depend on example sentences',()=>{
 for(const [action,product] of [['create an order for','dragon fruit'],['make an order with','copper fasteners'],['submit my order for','linen towels']]){
  const r=resolve(c,`${action} twenty one ${product} and ship to our office`);
  assert.equal(r.status,'RESOLVED');assert.equal(r.entities.items[0].quantity,21);assert.equal(r.entities.items[0].productText,product);assert.equal(r.entities.delivery.addressReference,'WORK');
 }
});
test('word-number conjunctions and quoted coordinated names remain intact',()=>{
 const r=resolve(c,'add one hundred and two "salt and pepper shakers" and three mugs then checkout');
 assert.equal(r.status,'RESOLVED');assert.equal(r.entities.items.length,2);assert.equal(r.entities.items[0].quantity,102);assert.equal(r.entities.items[0].productText,'salt and pepper shakers');
 const list=resolve(c,'add apples and milk then checkout');assert.equal(list.entities.items.length,2);
});
test('unresolved address preserves primary intent and items',()=>{
 const r=resolve(c,'create an order for two apples and deliver it there');
 assert.equal(r.status,'NEEDS_CONTEXT');assert.equal(r.primaryIntent,'CREATE_ORDER');assert.deepEqual(r.missing,['delivery.addressReference']);assert.equal(r.entities.items[0].quantity,2);
 assert.ok(r.references?.some(ref=>ref.kind==='address'&&!ref.resolved));
 const next=resolve(c,'home',r.context.next);
 assert.equal(next.status,'RESOLVED');assert.equal(next.entities.delivery.addressReference,'HOME');assert.equal(next.entities.items[0].quantity,2);assert.equal(next.context.next.pendingRequest,undefined);
});
test('order references stay unresolved without explicit conversational context',()=>{
 const first=resolve(c,'repeat my last order and deliver it tomorrow morning');
 assert.equal(first.status,'NEEDS_CONTEXT');assert.equal(first.primaryIntent,'REORDER');assert.equal(first.entities.order.reference,'LAST');assert.equal(first.entities.delivery.relativeDate,'TOMORROW');assert.equal(first.entities.delivery.timeWindow.period,'MORNING');
 const next=resolve(c,'order 15',{...first.context.next,referenceDate:'2026-09-22',timezone:'Africa/Cairo'});
 assert.equal(next.status,'RESOLVED');assert.equal(next.entities.order.resolvedReference,'15');assert.equal(next.entities.delivery.date,'2026-09-23');assert.equal(next.entities.delivery.timezone,'Africa/Cairo');
 assert.deepEqual(next.operations,['SET_DELIVERY_TIME','REPEAT_ORDER']);
});
test('same order with a changed address preserves relationship to prior order',()=>{
 const r=resolve(c,'create the same order but send it to my work address',{orderReference:'42'});
 assert.equal(r.status,'RESOLVED');assert.equal(r.primaryIntent,'CREATE_ORDER');assert.equal(r.entities.order.resolvedReference,'42');assert.equal(r.entities.delivery.addressReference,'WORK');assert.ok(r.references?.some(x=>x.expression==='IT'&&x.resolved));
});
test('a product reply fills a pending request without losing quantity',()=>{
 const first=resolve(c,'pls add two product to cart');assert.equal(first.status,'NEEDS_CONTEXT');
 const next=resolve(c,'fish',first.context.next);assert.equal(next.status,'RESOLVED');assert.equal(next.entities.productText,'fish');assert.equal(next.entities.quantity,2);assert.equal(next.entities.items,undefined);
});
test('pronouns refer to prior clauses or explicit selected items',()=>{
 const r=resolve(c,'find shoes and add them to the cart');assert.equal(r.status,'RESOLVED');assert.deepEqual(r.operations,['SEARCH_PRODUCTS','ADD_ITEM']);assert.ok(r.references?.some(x=>x.expression==='THEM'&&x.resolved));
 const selected=resolve(c,'add that then checkout',{selectedItems:[{productText:'rice',quantity:1}]});assert.equal(selected.status,'RESOLVED');assert.equal(selected.entities.items[0].productText,'rice');
 const missing=resolve(c,'add that then checkout');assert.equal(missing.status,'NEEDS_CONTEXT');assert.equal(missing.primaryIntent,'START_CHECKOUT');
});
test('dates and time windows are symbolic until a caller supplies a calendar anchor',()=>{
 const r=resolve(c,'create order for one book and deliver to home on 2026-10-05 between 9am and 11am');assert.equal(r.status,'RESOLVED');assert.equal(r.entities.delivery.date,'2026-10-05');assert.deepEqual(r.entities.delivery.timeWindow,{start:'09:00',end:'11:00'});
 const relative=resolve(c,'repeat last order and deliver tomorrow morning',{orderReference:'9'});assert.equal(relative.entities.delivery.date,undefined);
 for(const text of ['deliver on 2026-02-30','deliver between 9 and 11','deliver from 18:00 to 12:00']){const r=resolve(c,`add a book then ${text}`);assert.equal(r.status,'NEEDS_CONTEXT',text);}
});
test('negated clauses do not create operations and alternatives remain ambiguous',()=>{
 const r=resolve(c,'add apples to cart but do not checkout');assert.equal(r.status,'RESOLVED');assert.deepEqual(r.operations,['ADD_ITEM']);assert.equal(r.clauses?.[1].negated,true);
 assert.equal(resolve(c,'create an order or cancel my order').status,'AMBIGUOUS');
 assert.equal(resolve(c,'how do I create an order and deliver home').operations,undefined);
});
test('context validates bounds and rejects arbitrary IDs or authorization claims',()=>{
 const first=resolve(c,'create an order for two apples and deliver it there');assert.equal(validContext(first.context.next,c.dictionary),true);
 for(const bad of [null,[],{tenant:'other'},{pendingRequest:'x'.repeat(4001)},{selectedItems:[{productText:'fish',quantity:-1}]},{selectedItems:[{productText:'fish',productId:'invented'}]},{referenceDate:'2026-02-30'},{timezone:'invalid-zone'}])assert.equal(validContext(bad,c.dictionary),false);
});
test('successive missing fields retain known items without answering themselves',()=>{
 const first=resolve(c,'create order for two products and one milk and deliver it there');
 assert.equal(first.status,'NEEDS_CONTEXT');assert.match(first.message,/product/);
 const second=resolve(c,'fish',first.context.next);assert.equal(second.status,'NEEDS_CONTEXT');assert.deepEqual(second.missing,['delivery.addressReference']);
 const third=resolve(c,'home',second.context.next);assert.equal(third.status,'RESOLVED');assert.deepEqual(third.entities.items.map((i:any)=>[i.productText,i.quantity]),[['fish',2],['milk',1]]);assert.equal(third.entities.delivery.addressReference,'HOME');
});
test('over-limit and invalid quantities remain incomplete and produce valid next context',()=>{
 for(const text of ['add zero apples and one milk then checkout','add 1000001 apples and one milk then checkout',`add ${Array.from({length:51},(_,i)=>`one product${i}`).join(' and ')} then checkout`]) {
  const r=resolve(c,text);assert.equal(r.status,'NEEDS_CONTEXT',text);assert.ok(validContext(r.context.next,c.dictionary));
 }
});
test('compound order exposes typed slots and prioritizes item clarification deterministically',()=>{
 const unresolved=resolve(c,'create order for two products and deliver it there');
 assert.equal(unresolved.status,'NEEDS_CONTEXT');
 assert.match(unresolved.clarificationQuestion??'',/Which product or items should I include/);
 assert.equal(unresolved.slots?.find((slot:any)=>slot.code==='PRODUCT_TEXT')?.state,'REFERENCE_PENDING');
 assert.equal(unresolved.slots?.find((slot:any)=>slot.code==='DELIVERY_ADDRESS')?.state,'REFERENCE_PENDING');
 assert.deepEqual(unresolved.missing,['items[0].productText','delivery.addressReference']);
});
test('product orders require selection and prior-order reads require commerce authority',()=>{
 const request=resolve(c,'create an order for apples');
 assert.equal(request.status,'NEEDS_CONTEXT');
 assert.equal(request.intent,'PRODUCT_ACTION_CHOICE');
 assert.deepEqual(request.entities.productQueries,['apples']);
 assert.deepEqual(request.operations,[]);
 assert.deepEqual(request.actions,[]);
 assert.equal(request.fulfillment?.status,'NOT_EXECUTED');
 const prior=resolve(c,'repeat my last order');
 assert.equal(prior.status,'RESOLVED');
 assert.equal(prior.slots?.find((slot:any)=>slot.code==='ORDER_REFERENCE')?.state,'AUTHORITY_LOOKUP_REQUIRED');
});
test('clarification policy is additive to the existing flat response fields',()=>{
 const r=resolve(c,'add two products to cart');
 assert.equal(r.status,'NEEDS_CONTEXT');assert.equal(r.intent,'ADD_TO_CART');
 assert.equal(r.clarificationQuestion,'Which product would you like to add?');
 assert.equal(r.slots?.find((slot:any)=>slot.code==='PRODUCT_TEXT')?.state,'REFERENCE_PENDING');
});
test('comparison query and order tracking expose typed slots and authority requirements',()=>{
 const comparison=resolve(c,'compare apples');
 assert.equal(comparison.status,'RESOLVED');assert.equal(comparison.primaryIntent,'PRODUCT_COMPARE');
 assert.equal(comparison.slots?.find((slot:any)=>slot.code==='ITEMS')?.state,'RESOLVED');
 const complete=resolve(c,'compare apples and milk');assert.equal(complete.status,'RESOLVED');assert.deepEqual(complete.entities.items.map((item:any)=>item.productText),['apples','milk']);
 const tracking=resolve(c,'track my order');assert.equal(tracking.status,'RESOLVED');
 assert.equal(tracking.slots?.find((slot:any)=>slot.code==='ORDER_REFERENCE')?.state,'AUTHORITY_LOOKUP_REQUIRED');
 assert.equal(tracking.slots?.find((slot:any)=>slot.code==='ORDER_REFERENCE')?.requiresAuthorizationLookup,true);
 const bound=resolve(c,'track my order',{orderReference:'17'});assert.equal(bound.status,'RESOLVED');assert.equal(bound.entities.order.resolvedReference,'17');
});
test('delivery slot clarification follows required date then time policy order',()=>{
 const missing=resolve(c,'schedule delivery');assert.equal(missing.status,'NEEDS_CONTEXT');assert.deepEqual(missing.missing,['delivery.date','delivery.timeWindow']);
 assert.equal(missing.clarificationQuestion,'What delivery date should I use?');
 const ready=resolve(c,'schedule delivery for tomorrow morning');assert.equal(ready.status,'RESOLVED');assert.equal(ready.entities.delivery.relativeDate,'TOMORROW');assert.equal(ready.entities.delivery.timeWindow.period,'MORNING');
});
