import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {loadResolutionProvenance,resolutionEnvelope} from '../src/resolution-wire.ts';
const runtime=await loadRuntime(),provenance=await loadResolutionProvenance(runtime.dictionary);

test('rejected quantity replies preserve clarification without dangling discarded action links',()=>{
 const prior=resolve(runtime,'add 2 or 3 rings to my cart');
 assert.equal(prior.context.next.pendingClarification?.slot,'quantity');
 for(const answer of ['0','-3','1.5','3 or 4','3 and checkout','yes']){
  const next=resolutionEnvelope(resolve(runtime,answer,prior.context.next),provenance).result;
  assert.equal(next.status,'NEEDS_CONTEXT',answer);assert.deepEqual(next.actions,[]);assert.deepEqual(next.operations,[]);
  assert.deepEqual(next.relationships,[]);assert.deepEqual(next.references,[]);assert.deepEqual(next.slots,[]);assert.equal(next.graph,undefined);
  assert.equal((next.context?.next as any).pendingClarification.text,prior.text);
 }
});
test('an unparsed later negation discards the proposed action and its graph together',()=>{
 const text='Do not cancel the order; I only want to add apples to cart. Do not add anything';
 const next=resolutionEnvelope(resolve(runtime,text),provenance).result;
 assert.equal(next.status,'NEEDS_CONTEXT');assert.equal(next.intent,null);
 assert.deepEqual(next.entities,{});assert.deepEqual(next.actions,[]);assert.deepEqual(next.operations,[]);
 assert.deepEqual(next.relationships,[]);assert.deepEqual(next.references,[]);assert.deepEqual(next.slots,[]);assert.equal(next.graph,undefined);
 assert.ok(next.clauses?.length,'Linguistic clauses remain available with their source for clarification');
});
