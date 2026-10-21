import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {cartPricingRequested} from '../src/cart-pricing-language.ts';
const examples=['total cart items','total items in my cart','cart item count','how many items are in my cart','pls total cart items?','pls total of my items in cart','I need total of my items in cart','what is my cart total?', 'show me total discount in my cart','what are the discounts on my cart?', 'my basket subtotal','how much is my cart?', 'how much does my cart cost?', 'how much will I pay for my cart?', 'how much do I save on my cart?', 'cart tax','delivery fee for my cart','shipping cost for my basket','price breakdown for my cart','cart total after discount','total and discount for my cart','how much discount on my cart?','how much am I saving on my cart?'];
for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: cart pricing questions use the authorized cart read`,()=>{
  for(const text of examples){const r=resolve(c,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'CART_TOTAL',text);assert.equal(r.requiresConfirmation,false,text);assert.equal(r.text,text);}
 });
}
test('pricing reads do not consume writes, conditions, product searches or order pricing',()=>{
 for(const text of ['total cart items and remove milk','do not show total cart items','total cart items if I add tea','add milk to cart','cart total then checkout','cart total and clear cart','do not show cart total','cart total if I add milk','show total of my last order','find cart wheels under $100','"cart total"','cart total; remove milk','total discount for my cart without milk'])assert.equal(cartPricingRequested(text),false,text);
});
