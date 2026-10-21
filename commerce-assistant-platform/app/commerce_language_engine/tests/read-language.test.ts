import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {canonicalRead} from '../src/read-language.ts';

for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: shipping-status questions retain their explicit order reference`,()=>{
  for(const text of ['show me the shipping status of order 456446','Could you please check the delivery status for my order number 9382?','tell me the shipment status of order 702 please']){
   const r=resolve(c,text);
   assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'TRACK_ORDER',text);
   assert.equal(r.entities.order_reference,text.match(/\d+/)![0]);assert.equal(r.text,text);
  }
 });
 test(`${name}: explicit availability questions retain product identity`,()=>{
  for(const product of ['Search-79738','copper fasteners','Showw-813','coffee']){
   for(const text of [`do you have ${product} available?`,`Have you got ${product} available now?`]){
    const r=resolve(c,text);assert.equal(r.status,'RESOLVED',text);
    assert.equal(r.intent,'CHECK_STOCK');assert.equal(r.entities.productText,product.toLowerCase());
    assert.equal(r.text,text);assert.equal(r.requiresConfirmation,false);
   }
  }
  assert.equal(resolve(c,'do you have headphones?').intent,'PRODUCT_SEARCH');
  assert.equal(resolve(c,'find shipping status stickers').intent,'PRODUCT_SEARCH');
 });
}
test('read paraphrases never consume negations, quoted commands or additional actions',()=>{
 for(const text of [
  'do not show me the shipping status of order 123',
  'show me the shipping status of order 123 then cancel it',
  'show me the shipping status of order 123 or order 456',
  '"show me the shipping status of order 123"',
  'explain how to show me the shipping status of order 123',
  'do you have shoes and cancel my order available?',
  'do you have shoes available? then add them to cart',
  'do you have no shoes available?',
 ])assert.equal(canonicalRead(text),undefined,text);
});
