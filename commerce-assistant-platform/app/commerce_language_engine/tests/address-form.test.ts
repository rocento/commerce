import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
const compiled=await loadRuntime();
test('whole address-form requests preserve original input and recognize bounded typo',()=>{
 for(const text of ['pls add my new current addresss','Add a new address.','Could you please add my delivery address?','please create a shipping address']){
  const r=resolve(compiled,text);
  assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'ACCOUNT_ADDRESS_ADD',text);assert.equal(r.text,text);
 }
});
test('negations, products and compound requests do not open an address form',()=>{
 for(const text of ["don't add my new address",'I do not need a new address','find addresss labels','add address labels to cart','add my address and delete my old address','"add my new address"']){
  const r=resolve(compiled,text);
  assert.ok(r.status!=='RESOLVED'||r.intent!=='ACCOUNT_ADDRESS_ADD',text);
 }
});
