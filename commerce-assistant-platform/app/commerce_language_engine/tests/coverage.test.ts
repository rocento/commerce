import './recognition-test-context.ts';
import {rocentoIntentCodes,compatibleCase} from '../src/rocento-capabilities.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {authoredCoverageCases,compositionalCoverageCases} from '../src/generation/coverage-cases.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const d=buildExpandedDictionary(),c=compile(d);
test('authored linguistic structures retain their independent semantic labels',()=>{
 for(const t of [...authoredCoverageCases()].filter(t=>compatibleCase(t,rocentoIntentCodes))){
  const r=resolve(c,t.text,t.context);
  const resolvedWithMissingSlot=r.status==='NEEDS_CONTEXT'&&r.primaryIntent===t.intent&&!!r.missing?.length;
  assert.ok(r.intent===t.intent||resolvedWithMissingSlot,t.text);assert.ok(r.status===(t.status??'RESOLVED')||resolvedWithMissingSlot,t.text);
 }
});
test('all six reorder formulations share the same intent and order references stay scoped',()=>{
 for(const text of ['recreate my last order','repeat the previous order','order the same things again','same last order please','buy what I bought before','do that order again']){
  const r=resolve(c,text,{previousIntent:'SELECT_ORDER',states:['ORDER_SELECTED']});
  assert.equal(r.intent,'REORDER',text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.entities.product_reference,undefined,text);
 }
 assert.equal(resolve(c,'do that order again').status,'NEEDS_CONTEXT');
 assert.deepEqual(resolve(c,'do that order again').missing,['orderReference']);
});
test('reference atoms cannot independently invent a purchase or cross domains',()=>{
 for(const text of ['same','last','previous','again','same color','repeat the previous paragraph','never order the same things again','translate recreate my last order'])assert.equal(resolve(c,text).intent,null,text);
 assert.equal(resolve(c,'same again',{previousIntent:'ORDER_DETAILS',states:['ORDER_SELECTED']}).intent,'REORDER');
 assert.equal(resolve(c,'same again',{previousIntent:'PRODUCT_SEARCH',states:['PRODUCT_RESULTS_VISIBLE']}).intent,null);
});
test('action/object/reference proximity is required, not bag-of-words co-occurrence',()=>{
 const r=resolve(c,'buy '+Array(30).fill('unrelated').join(' ')+' what I bought before');assert.notEqual(r.intent,'REORDER');
});
test('expanded dataset covers held-out structures, ambiguity, noise, negatives and fragments',()=>{
 const cases=[...authoredCoverageCases(),...compositionalCoverageCases(d)];
 assert.ok(cases.length>5000);
 const counts=new Map<string,number>(),families=new Map<string,Set<string>>();
 for(const t of cases){counts.set(t.difficulty,(counts.get(t.difficulty)??0)+1);const splits=families.get(t.templateFamily!)??new Set();splits.add(t.split!);families.set(t.templateFamily!,splits);}
 for(const difficulty of ['PARAPHRASE','NEGATION','HARD_NEGATIVE','AMBIGUOUS','INCOMPLETE','TYPO_NOISE','CONTEXT_REQUIRED'])assert.ok((counts.get(difficulty)??0)>=10,difficulty);
 assert.ok(families.size>=55);assert.ok([...families.values()].every(s=>s.size===1));
});
test('ontology expansion interns exact equivalents and retains catalog separation',()=>{
 const identities=new Set<string>();
 for(const g of d.groups){
  const role=g.code.startsWith('ACTION_')?'ACTION':g.code.startsWith('OBJECT_')?'OBJECT':g.category;
  const key=role+'|'+g.terms.slice().sort().join('|');assert.ok(!identities.has(key),g.code);identities.add(key);
  assert.notEqual(g.category,'CATEGORY');
 }
 const addedConcepts=d.groups.filter(g=>g.terms.every(t=>g.termMetadata?.[t]?.source==='coverage-ontology-v6'));
 assert.ok(addedConcepts.length<=12,'coverage should reuse concepts rather than create sentence groups');
});
test('open product noun phrases do not create unrelated action/object candidates',()=>{
 const empty=structuredClone(d);empty.entity_terms=[];const withoutCatalog=compile(empty);
 for(const product of ['contact lens solution','laundry basket','support bracket','order organizers']){
  const a=resolve(c,'find '+product),b=resolve(withoutCatalog,'find '+product);
  assert.equal(a.intent,'PRODUCT_SEARCH',product);assert.equal(a.status,'RESOLVED',product);
  assert.equal(a.entities.productText,product);assert.deepEqual(a.debug.candidates,b.debug.candidates);
 }
 assert.equal(resolve(c,'show product reviews').intent,'PRODUCT_REVIEWS');
 assert.equal(resolve(c,'find chairs and add them to the cart').status,'RESOLVED');
});
test('indirect event rules respect denied commands and explicit alternatives remain ambiguous',()=>{
 for(const text of ['never display my battery runtime','I said not to report my missing refund','you must not inspect my rewards expiration','I said not to report my missing points'])assert.equal(resolve(c,text).status,'UNKNOWN',text);
 for(const text of ['either cancel or create my restock notification','cancel my restock notification or create my restock notification'])assert.equal(resolve(c,text).status,'UNKNOWN',text);
 assert.equal(resolve(c,'my points were not credited').intent,null);
});

test('tracking questions preserve latest-order references without suggesting creation',()=>{
 for(const text of ['Where is my last order?','Where is my latest order?','Where is my most recent order?','track my last order']){
  const r=resolve(c,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'TRACK_ORDER',text);assert.equal(r.entities.orderSelection,'LATEST',text);
 }
 for(const text of ['do not track my last order','never track my latest order'])assert.notEqual(resolve(c,text).status,'RESOLVED',text);
 assert.equal(resolve(c,'show my latest order').intent,'ORDER_HISTORY');
});

test('first and oldest order reads are history requests rather than product searches',()=>{
 for(const text of ['pls show me first order','show my first order','show my oldest order','show my earliest order']){
  const r=resolve(c,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'ORDER_HISTORY',text);
 }
});
