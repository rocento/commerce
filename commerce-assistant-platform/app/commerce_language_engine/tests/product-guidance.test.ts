import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {productGuidance} from '../src/product-guidance.ts';
const runtime=await loadRuntime();
test('guides incomplete positive commands while preserving original spelling and SKU',()=>{
 for(const [message,query,quantity] of [['pls add banans','banans',1],['Could you add two green tea please?','green tea',2],['save SKU-GRN-007','SKU-GRN-007',1],['add 4 coffee','coffee',4]] as const){
 const r=resolve(runtime,message);assert.equal(r.status,'NEEDS_CONTEXT');assert.equal(r.intent,'PRODUCT_ACTION_CHOICE');assert.equal(r.entities.productText,query);assert.equal(r.entities.quantity,quantity);assert.equal(r.text,message);assert.deepEqual(r.operations,[]);
 }
});
test('keeps explicit destinations and existing non-product actions on their normal paths',()=>{
 for(const s of ['add tea to cart','save tea to wishlist','pls add my new current addresss','compare tea and coffee','add coupon SAVE20'])assert.notEqual(resolve(runtime,s).intent,'PRODUCT_ACTION_CHOICE',s);
 assert.equal(resolve(runtime,'compare bananas').intent,'PRODUCT_COMPARE');
});
test('does not guide negated, conditional, compound, invalid quantities or constrained commands',()=>{
 for(const s of ["don't add bananas",'I don’t need shoes','add -3 bananas','add 0 bananas','add 1.5 bananas','add 1000001 bananas','add bananas and remove tea','add bananas if available','add shoes under $20','add bananas; cancel order','add tea without sugar','add two 3 tea','add 2 kg bananas','add 1 dozen eggs','add two','add this','add two bottles of milk'])assert.equal(productGuidance(s),undefined,s);
});

test('offers a removal destination only for incomplete removal commands', () => {
 assert.deepEqual(productGuidance('remove banaa'), {query:'banaa',quantity:1,action:'remove'});
 assert.deepEqual(productGuidance('pls remove two bananas'), {query:'bananas',quantity:2,action:'remove'});
 for (const text of ['remove bananas from cart','remove bananas from wishlist',"don't remove bananas",'remove bananas and tea','remove this']) assert.equal(productGuidance(text), undefined, text);
});

test('routes all-item removal to clear cart or a destination choice', () => {
 const clear = resolve(runtime, 'remove all items from cart');
 assert.equal(clear.intent, 'CLEAR_CART');
 assert.equal(clear.status, 'RESOLVED');
 for (const text of ['remove all items from', 'remove all items', 'pls remove all products from']) {
  const result = resolve(runtime, text);
  assert.equal(result.intent, 'PRODUCT_ACTION_CHOICE');
  assert.equal(result.entities.productText, 'all items');
  assert.deepEqual(result.operations, []);
 }
 for (const text of ["don't remove all items from cart", 'remove all items from cart except bananas', 'remove all items from cart if empty']) {
  const result = resolve(runtime, text);
  assert.ok(result.intent !== 'CLEAR_CART' || result.status !== 'RESOLVED');
 }
});
