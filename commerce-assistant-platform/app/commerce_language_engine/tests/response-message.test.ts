import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const c=compile(buildExpandedDictionary());
test('every resolution status has a short customer-facing message',()=>{
 for(const [text,status] of [['find apples','RESOLVED'],['new order','AMBIGUOUS'],['nonsense','UNKNOWN'],['add two items to cart','NEEDS_CONTEXT']]){
  const r=resolve(c,text);assert.equal(r.status,status);assert.equal(typeof r.message,'string');assert.ok(r.message.length>10&&r.message.length<220);assert.ok(!r.message.includes('_'));
 }
});
test('resolved mutation messages acknowledge intent without claiming execution',()=>{
 const cart=resolve(c,'pls i need add any two fresh items in cart');assert.equal(cart.message,'Which product or items do you mean?');assert.equal(cart.fulfillment?.status,'NOT_EXECUTED');
 const cancel=resolve(c,'cancel my order');assert.ok(cancel.message.includes('confirm'));assert.ok(!cancel.message.includes('cancelled'));
});
test('clarification messages identify missing data and multiple actions',()=>{
 assert.equal(resolve(c,'add two items to cart').message,'Which product or items do you mean?');
 assert.ok(resolve(c,'add shoes to cart and remove socks from cart').message.includes('no commerce action has been executed'));
 assert.equal(resolve(c,'  ').message,'Please enter a request.');
});
