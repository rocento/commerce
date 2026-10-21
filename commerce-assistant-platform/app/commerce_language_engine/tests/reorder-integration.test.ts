import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
const compiled=await loadRuntime();
test('numbered buy-again commands provide a high-confidence owned-order lookup argument',()=>{
 for(const text of ['buy again order 5','reorder order 5','buy again order #5']) {
  const r=resolve(compiled,text,{});
  assert.equal(r.status,'RESOLVED');
  assert.equal(r.intent,'REORDER');
  assert.equal(r.entities.order_reference,'5');
  assert.ok(r.confidence>=0.85);
 }
});
test('negated reorder is not an executable reorder',()=>{
 const r=resolve(compiled,'do not buy again order 5',{});
 assert.notEqual(r.intent,'REORDER');
});
