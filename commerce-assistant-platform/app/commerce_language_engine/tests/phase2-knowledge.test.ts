import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {canonicalKnowledge,knowledgeTokens} from '../src/language-knowledge.ts';
import {assertKnowledgeReviewed,assertKnowledgeUpgrade} from '../src/rule-governance.ts';
import {explainKnowledge} from '../src/knowledge-explanation.ts';
import {lexicalConcept} from '../src/lexical-knowledge.ts';
const base=(recognitionFixture(JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const old=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-governed-v1.json',import.meta.url),'utf8'));
const pack=canonicalKnowledge(JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-phase2-v1.json',import.meta.url),'utf8')));
const engine=compile({...base,languageKnowledge:pack});
const relations=(r:any)=>r.entities.shoppingContext?.relations??[];

test('Phase 2 aliases are scoped, reachable, hash-reviewed and cannot alter entity authority',()=>{
 assertKnowledgeReviewed(pack);assertKnowledgeUpgrade(old,pack);assert.deepEqual(canonicalKnowledge(pack),pack);
 assert.deepEqual(engine.dictionary.entity_terms,base.entity_terms);
 for(const concept of pack.concepts)if(concept.metadata?.lexicalReview){
  assert.ok(concept.metadata.domains);assert.ok(concept.metadata.usage);
  for(const form of [concept.canonical,...concept.aliases])assert.equal(lexicalConcept(engine.languageKnowledge,concept.kind,form)?.id,concept.id,form);
 }
 for(const mutate of [(p:any)=>p.concepts.find((c:any)=>c.kind==='material').aliases.push('unreviewed spelling'),(p:any)=>p.concepts.find((c:any)=>c.kind==='material').metadata.domains=['pharmacy'],(p:any)=>{delete p.concepts.find((c:any)=>c.kind==='material').metadata.lexicalReview;},(p:any)=>{delete p.ruleGovernance;delete p.budgetRules;}]){
  const changed=structuredClone(pack);mutate(changed);assert.throws(()=>canonicalKnowledge(changed));
 }
 assert.equal(knowledgeTokens('stainless-steel').join(' '),'stainless-steel');
});
test('material and color meanings retain their kind, source spans and exclusion polarity',()=>{
 for(const marker of ['made of','made from','with']){
  const text='Find scarf '+marker+' cotton without green',r=resolve(engine,text);
  assert.equal(r.status,'RESOLVED',text);assert.equal(r.entities.productText,'scarf');
  assert.deepEqual(relations(r).map((x:any)=>[x.relation,x.value,x.negated]),[['material','cotton',false],['color','green',true]]);
  for(const x of relations(r))assert.equal([...text].slice(x.start,x.end).join(''),x.text);
 }
 for(const marker of ['without','except','except for','excluding','but not','with no']){
  const r=resolve(engine,'Find scarf '+marker+' cotton');assert.equal(r.status,'RESOLVED',marker);assert.equal(relations(r)[0]?.negated,true);
 }
 const list=resolve(engine,'Find necklace without brass and nickel');assert.equal(list.status,'RESOLVED');assert.equal(relations(list).length,2);assert.ok(relations(list).every((x:any)=>x.negated));
 const colors=resolve(engine,'Find scarf without green and yellow');assert.equal(colors.status,'RESOLVED');assert.equal(relations(colors).length,2);
});
test('unknown words, double negatives, conflicts and unsafe suffixes cannot become satisfied searches',()=>{
 for(const text of ['Find scarf made of unknownword','Find scarf not without cotton','Find scarf in green without green','Find necklace without brass and copper','Find scarf made of cotton or nylon','Find scarf made of cotton and checkout','Find scarf made of cotton if it is allergy safe']){
  const r=resolve(engine,text);assert.notEqual(r.status,'RESOLVED',text);
 }
 const r=resolve(engine,'Find charger with iPhone 13');assert.equal(r.status,'NEEDS_CONTEXT');assert.deepEqual(r.actions,[]);
 const write=resolve(engine,'Buy scarf made of cotton');assert.equal(write.entities.shoppingContext,undefined);
});
test('recipient, intended-use and country roles compose without adding recipient traits or device facts',()=>{
 const r=resolve(engine,'Find laptop for my mentor and my godmother for podcasting and invoicing');
 assert.equal(r.status,'RESOLVED');assert.deepEqual(relations(r).map((x:any)=>[x.relation,x.value]),[['recipient','mentor'],['recipient','godmother'],['intended_use','podcasting'],['intended_use','invoicing']]);
 assert.equal(r.entities.gender,undefined);assert.equal(r.entities.age,undefined);
 const device=resolve(engine,'Find charger compatible with Google Pixel 7');assert.equal(device.status,'RESOLVED');assert.equal(device.entities.evidenceRequirements?.[0]?.kind,'named_device_compatibility');assert.equal(device.entities.compatible,undefined);
 const route=resolve(engine,'Find scarf made in France shipping to Japan');assert.equal(route.status,'RESOLVED');assert.deepEqual(relations(route).map((x:any)=>x.relation),['origin_country','destination_country']);
});
test('range and spending-limit rules emit price evidence and reject incoherent money',()=>{
 const text='Find laptop for bookkeeping and my budget is from $180 to $720',r=resolve(engine,text);
 assert.equal(r.status,'RESOLVED');assert.deepEqual(r.entities.price,{operator:'BETWEEN',min:180,max:720,currency:'USD'});
 assert.ok(explainKnowledge(engine,text).evidence.some(x=>x.ruleId==='budget.inline.range'));
 const cap=resolve(engine,'Find laptop to do bookkeeping and my spending limit is €720');assert.equal(cap.status,'RESOLVED');assert.deepEqual(cap.entities.price,{operator:'<=',value:720,currency:'EUR'});
 for(const suffix of ['from $720 to $180','between $180 and €720','between $180 EUR and $720'])assert.notEqual(resolve(engine,'Find laptop for bookkeeping and my budget is '+suffix).status,'RESOLVED');
});
test('multiple follow-ups preserve minimum, currency, recipient, exclusions and the changed purpose/material',()=>{
 let context:any={};let last:any;
 for(const text of ['Find laptop for my godfather for bookkeeping and my budget is between $180 and $720','Same budget but for programming','Change budget to $650']){last=resolve(engine,text,context);assert.equal(last.status,'RESOLVED',text);context=last.context.next;}
 assert.deepEqual(last.entities.price,{operator:'BETWEEN',min:180,max:650,currency:'USD'});assert.deepEqual(relations(last).map((x:any)=>x.value),['godfather','programming']);
 const first=resolve(engine,'Find necklace made of brass without green under $500');const second=resolve(engine,'Change material to ceramic',first.context.next);
 assert.equal(second.status,'RESOLVED');assert.deepEqual(relations(second).map((x:any)=>[x.value,x.negated]),[['green',true],['ceramic',false]]);assert.deepEqual(second.entities.price,first.entities.price);
});
test('published package and dimension terms provide literal annotations without catalog claims',()=>{
 const r=resolve(engine,'Find three tins of tea');assert.equal(r.status,'RESOLVED');assert.equal(r.entities.quantity,3);assert.equal(r.product_meaning?.unit,'tin');
 const dimensions=resolve(engine,'Find chain length 45 cm');assert.equal(dimensions.product_meaning?.attributes?.length,'45 cm');
 assert.equal(resolve(engine,'Find chain length 45 kg').product_meaning?.attributes?.length,undefined);
});
