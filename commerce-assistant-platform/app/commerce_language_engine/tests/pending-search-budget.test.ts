import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const engine=compile((recognitionFixture(JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8')))));
test('a budget edit of a pending shopping goal is understood but not applied or executed',()=>{
 const first=resolve(engine,'My mother hates heavy earrings. Show me something lightweight for under $15. Keep it short.');
 assert.equal(first.status,'NEEDS_CONTEXT');assert.ok(first.context.next.pendingRequest);
 const result=resolve(engine,'Actually my budget is $20 now. What would you change?',first.context.next);
 assert.equal(result.status,'NEEDS_CONTEXT');assert.deepEqual(result.entities.price,{operator:'<=',value:20,currency:'USD'});
 assert.deepEqual(result.operations,[]);assert.equal(result.context.next.pendingRequest,first.context.next.pendingRequest);
 assert.equal(result.context.next.activeSearch,undefined);assert.match(result.message,/before I can apply/);
});
test('budget wording does not complete a pending cart write or discard extra actions',()=>{
 const context={pendingRequest:'add to cart'};
 const result=resolve(engine,'Actually my budget is $20 now. What would you change?',context);
 assert.notEqual(result.status,'RESOLVED');assert.notEqual(result.intent,'ADD_TO_CART');
 const extra=resolve(engine,'My budget is $20 now and checkout',context);
 assert.notEqual(extra.searchUpdate,true);
});
