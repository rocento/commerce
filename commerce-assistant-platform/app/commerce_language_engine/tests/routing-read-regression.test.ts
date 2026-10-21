import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {loadRuntime} from '../src/runtime.ts';
import {canonicalRead} from '../src/read-language.ts';
import {productFactRead} from '../src/product-facts-language.ts';
import {wishlistReadRequested} from '../src/wishlist-read-language.ts';

const selected={states:['PRODUCT_SELECTED'],previousIntent:'SELECT_PRODUCT',selectedItems:[{productText:'Demo Product'}]};

for(const [name,runtime] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: whole supported field reads own their complete noun phrase`,()=>{
  for(const [text,intent] of [
   ['Tell me material safety data sheet','SAFETY_DATA_SHEET'],
   ['please tell me material safety data sheet','SAFETY_DATA_SHEET'],
   ['Could you show me the material safety data sheet please?','SAFETY_DATA_SHEET'],
   ['Check the price per unit please','UNIT_PRICE'],
   ['show me the unit price','UNIT_PRICE'],
   ['Tell me the price per unit','UNIT_PRICE'],
  ]){
   const result=resolve(runtime,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,intent,text);
   assert.equal(result.entities.productText,undefined,text);
   assert.equal(result.entities.order,undefined,text);
   assert.equal(result.requiresConfirmation,false,text);
   assert.equal(result.text,text);
  }
 });
 test(`${name}: saved favorites are the shopper's collection, not a catalog search`,()=>{
  for(const text of ['Could you let me see my saved favorites?','Please show my saved favourites','open my saved favorites','my saved favorites']){
   const result=resolve(runtime,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,'VIEW_WISHLIST',text);
   assert.equal(result.entities.productText,undefined,text);
   assert.equal(result.requiresConfirmation,false,text);
  }
  assert.equal(resolve(runtime,'find saved favorites stickers').intent,'PRODUCT_SEARCH');
 });
 test(`${name}: supported duration and sizing questions require a current product`,()=>{
  for(const [text,intent] of [
   ['How much time can I use it before recharging?','PRODUCT_BATTERY_LIFE'],
   ['How long does its battery last?','PRODUCT_BATTERY_LIFE'],
   ['Do you have a chart to help me pick a size?','PRODUCT_SIZE_GUIDE'],
   ['Do you have a sizing chart for this product?','PRODUCT_SIZE_GUIDE'],
   ['check the price of it','CHECK_PRICE'],
   ['what material is it made of','PRODUCT_MATERIAL'],
  ]){
   for(const context of [{},{selectedItems:[{productText:'Unconfirmed Product'}]}]){
    const result=resolve(runtime,text,context);
    assert.equal(result.intent,intent,text);
    assert.equal(result.status,'NEEDS_CONTEXT',text);
    assert.deepEqual(result.missing,['productReference'],text);
    assert.match(result.message,/Which product/);
    assert.equal(result.entities.product_reference,'CURRENT',text);
    assert.equal(result.entities.productText,undefined,text);
    assert.equal(result.fulfillment?.needsClarification,true,text);
    assert.deepEqual(result.fulfillment?.unresolvedSlots,[{slot:'productReference',reason:'PRODUCT_SELECTION_REQUIRED'}],text);
    assert.deepEqual(result.operations,[],text);
    assert.deepEqual(result.actions,[],text);
   }
   const resolved=resolve(runtime,text,selected);
   assert.equal(resolved.status,'RESOLVED',text);
   assert.equal(resolved.intent,intent,text);
   assert.equal(resolved.entities.product_reference,'CURRENT',text);
   assert.equal(resolved.entities.productText,undefined,text);
   assert.equal(resolved.requiresConfirmation,false,text);
   assert.equal(resolved.fulfillment?.needsClarification,false,text);
   assert.deepEqual(resolved.operations,[],text);
   assert.deepEqual(resolved.actions,[],text);
  }
 });
 test(`${name}: named field reads retain the supplied identity without inventing facts`,()=>{
  for(const [text,intent,product] of [
   ['What is the battery life of Search-79738?','PRODUCT_BATTERY_LIFE','Search-79738'],
   ['What is the price per unit of Gala Apples?','UNIT_PRICE','Gala Apples'],
   ['What is the size guide for Aurora Ring?','PRODUCT_SIZE_GUIDE','Aurora Ring'],
   ['show material safety data sheet of Solvent-100','SAFETY_DATA_SHEET','Solvent-100'],
  ]){
   const result=resolve(runtime,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,intent,text);
   assert.deepEqual(result.entities,{productText:product},text);
   assert.equal(result.requiresConfirmation,false,text);
   assert.deepEqual(result.operations,[],text);
   assert.deepEqual(result.actions,[],text);
  }
 });
 test(`${name}: tracking a refund preserves the refund object and any order reference`,()=>{
  for(const text of ['track my refund','track the refund for me','please track my refund','Could you check the status of my refund please?','trace the refund progress for me','track reimbursement status','track my refund before we continue','track the refund I mentioned earlier']){
   const result=resolve(runtime,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,'REFUND_STATUS',text);
   assert.equal(result.entities.order,undefined,text);
   assert.equal(result.actions?.some(action=>action.intent==='TRACK_ORDER'),undefined,text);
   assert.equal(result.requiresConfirmation,false,text);
  }
  const numbered=resolve(runtime,'track my refund for order number 123');
  assert.equal(numbered.intent,'REFUND_STATUS');
  assert.equal(numbered.entities.order_reference,'123');
  assert.equal(resolve(runtime,'track order 123').intent,'TRACK_ORDER');
  assert.notEqual(resolve(runtime,'When will my refund reach my bank?').intent,'REFUND_STATUS');
 });
}

test('read ownership does not consume negation, extra actions, hypotheticals or quoted commands',()=>{
 for(const text of [
  'do not tell me material safety data sheet',
  'tell me material safety data sheet then buy it',
  'check price per unit and add it to cart',
  'if in stock check the price per unit',
  'track my refund and cancel order 123',
  '"track my refund"',
  'track my refund for order 123 or order 456',
 ])assert.equal(canonicalRead(text),undefined,text);
 for(const text of [
  'How much time can I use it before recharging and buy it?',
  'If available, what is the battery life of Search-79738?',
  'Do not show me the sizing chart for Aurora Ring',
  '"What is the price per unit of Gala Apples?"',
 ])assert.equal(productFactRead(text),undefined,text);
 for(const text of ['do not show my saved favorites','show my saved favorites then clear my cart','"show my saved favorites"'])assert.equal(wishlistReadRequested(text),false,text);
});
