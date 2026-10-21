import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
const d=buildExpandedDictionary(),c=compile(d);
test('user request resolves its action separately from catalog fulfillment',()=>{
 const r=resolve(c,'pls i need add any two fresh items in cart');assert.equal(r.status,'NEEDS_CONTEXT');assert.equal(r.intent,'ADD_TO_CART');assert.equal(r.entities.quantity,2);assert.equal(r.entities.freshness,'fresh');assert.equal(r.entities.selection,'ANY_MATCHING');assert.equal(r.fulfillment?.status,'NOT_EXECUTED');assert.equal(r.fulfillment?.needsClarification,true);assert.ok(r.debug.suppressedPrefixes.some(m=>m.phrase==='i need'));
});
test('request prefixes defer to a subsequent command; a concrete need can search with quantity',()=>{
 for(const prefix of ['i need to','i want to','pls i need','help me','could you please'])assert.equal(resolve(c,prefix+' add two shirts to my cart').intent,'ADD_TO_CART',prefix);
 const search=resolve(c,'i need two shirts');assert.equal(search.status,'RESOLVED');assert.equal(search.intent,'PRODUCT_SEARCH');assert.equal(search.entities.quantity,2);assert.equal(search.entities.productText,'shirts');assert.equal(search.debug.suppressedPrefixes.length,0);
});
test('quantity syntax allows quantifiers, word numbers and grouping',()=>{
 for(const [phrase,quantity] of [['any two',2],['a couple of',2],['half a dozen',6],['twenty one',21],['twenty-one',21],['one hundred and two',102],['a',1],['12',12]] as const){const r=resolve(c,`put ${phrase} fresh items in my basket`);assert.equal(r.intent,'ADD_TO_CART');assert.equal(r.entities.quantity,quantity,phrase);}
 const r=resolve(c,'add two or three items to cart');assert.equal(r.intent,'ADD_TO_CART');assert.deepEqual(r.entities.quantityRange,{min:2,max:3});assert.equal(r.fulfillment?.needsClarification,true);
});
test('direct objects distinguish coupon application from adding products',()=>{assert.equal(resolve(c,'add coupon SAVE10 to cart').intent,'APPLY_COUPON');assert.notEqual(resolve(c,'add a gift card to my cart').intent,'ADD_TO_CART');});
test('destination distinguishes cart and wishlist even when cart is mentioned as a modifier',()=>{assert.equal(resolve(c,'add two cart items to my wishlist').intent,'ADD_TO_WISHLIST');assert.equal(resolve(c,'take two items from my basket').intent,'REMOVE_FROM_CART');});
test('negated commands and instructions do not become cart actions',()=>{for(const text of ['do not add two fresh items to cart','never put any two items in cart','show me how to add shirts to cart','what happens if i add two items to my cart'])assert.equal(resolve(c,text).status,'UNKNOWN',text);});
test('related actions expose a semantic plan instead of flattening or rejecting them',()=>{const r=resolve(c,'find shoes and add them to the cart');assert.equal(r.status,'RESOLVED');assert.equal(r.requestType,'COMPOUND');assert.ok(r.requestedIntents?.includes('PRODUCT_SEARCH'));assert.ok(r.requestedIntents?.includes('ADD_TO_CART'));assert.equal(resolve(c,'add shoes to cart and remove socks from cart').status,'RESOLVED');});
test('multiple item quantities are preserved rather than pretending one count describes everything',()=>{const r=resolve(c,'add two shirts and three jeans to my cart');assert.equal(r.intent,'ADD_TO_CART');assert.equal(r.entities.quantity,undefined);assert.deepEqual(r.entities.line_items.map((x:any)=>x.quantity),[2,3]);});
test('unknown concrete catalog items can still have a known commerce action',()=>{const r=resolve(c,'please pop three mangosteens in the basket');assert.equal(r.intent,'ADD_TO_CART');assert.equal(r.entities.quantity,3);assert.equal(r.fulfillment?.unresolvedSlots[0].reason,'CATALOG_MATCHING_REQUIRED');});
