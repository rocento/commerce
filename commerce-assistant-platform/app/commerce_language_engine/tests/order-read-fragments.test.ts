import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {canonicalRead} from '../src/read-language.ts';
const runtime=await loadRuntime();
test('bare first-order fragments are read-only requests and retain the original text',()=>{
 for(const text of ['first order /','first order','my first order','pls first order /','earliest order?','the oldest order please']){
  const r=resolve(runtime,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'ORDER_HISTORY',text);assert.equal(r.text,text);
 }
});
test('order fragment recognition does not consume actions, negations, product names or clauses',()=>{
 for(const text of ['place my first order','cancel my first order','reorder my first order','do not show my first order','first order / cancel it','find first order coffee','"first order"','first order under $20','first','second order','first order #305'])assert.equal(canonicalRead(text),undefined,text);
});
