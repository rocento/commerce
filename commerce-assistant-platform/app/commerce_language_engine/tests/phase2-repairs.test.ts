import {recognitionSeed} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {canonicalKnowledge,knowledgeHash} from '../src/language-knowledge.ts';
import {assertKnowledgeReviewed,assertKnowledgeUpgrade} from '../src/rule-governance.ts';
import {explainKnowledge} from '../src/knowledge-explanation.ts';
const read=(path:string)=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const before=canonicalKnowledge(read('../data/knowledge/shopping-en-phase2-v1.json'));
const pack=canonicalKnowledge(read('../data/knowledge/shopping-en-phase2-v2.json'));
const engine=compile({...read('../data/compiled.json'),recognitionRules:recognitionSeed(),languageKnowledge:pack});
const relations=(r:any)=>r.entities.shoppingContext?.relations??[];
const noActions=(r:any)=>{assert.deepEqual(r.actions??[],[]);assert.deepEqual(r.operations??[],[]);};
test('revision 8 preserves revision 7 and requires reviewed v3 policies',()=>{
 assert.equal(knowledgeHash(before),'5494fbab43bd8d9d6a1347c12d95497dbebabe95a6f250eb22e295691ca1e162');
 assertKnowledgeUpgrade(before,pack);assertKnowledgeReviewed(pack);assert.deepEqual(canonicalKnowledge(pack),pack);
 assert.equal(pack.concepts.length,before.concepts.length);assert.equal(pack.ruleGovernance!.length,88);
 for(const id of ['for.recipient','for.audience','compatible.with.device','device.that_works_with','device.to_use_with'])assert.equal(pack.ruleGovernance!.find(r=>r.ruleId===id)!.version,2);
 const tamper=structuredClone(pack);tamper.ruleGovernance!.find(r=>r.ruleId==='for.possessive_collective')!.runtime='knowledge-composition-v2';assert.throws(()=>canonicalKnowledge(tamper),/v3 runtime/);
});
test('explicit ownership makes collective recipients; bare groups remain audiences',()=>{
 for(const word of ['family','household','team']){
  for(const owner of ['my','our','his','her','their','your']){
   const text='Find bread for '+owner+' '+word,r=resolve(engine,text);assert.equal(r.status,'RESOLVED',text);
   assert.deepEqual(relations(r).map((x:any)=>[x.relation,x.value]),[['recipient',word]]);assert.equal(relations(r)[0].ruleId,'for.possessive_collective');assert.equal(r.entities.gender,undefined);
  }
  const bare=resolve(engine,'Find bread for '+word);assert.equal(bare.status,'RESOLVED');assert.equal(relations(bare)[0].relation,'audience');
 }
 const generic=resolve(engine,'Find bread for women');assert.equal(relations(generic)[0].relation,'audience');
 const owner=resolve(engine,"Find charger for my mother's iPhone 13");assert.equal(relations(owner).length,0);assert.equal(owner.entities.evidenceRequirements?.[0]?.kind,'named_device_compatibility');
});
test('possessive inheritance is bounded by a repeated preposition and keeps mixed roles',()=>{
 const combined=resolve(engine,'Find bread for our household and team and my mother for breakfast');assert.equal(combined.status,'RESOLVED');
 assert.deepEqual(relations(combined).map((r:any)=>[r.relation,r.value]),[['recipient','household'],['recipient','team'],['recipient','mother'],['intended_use','breakfast']]);
 const reset=resolve(engine,'Find bread for my family and for teams');assert.equal(reset.status,'RESOLVED');assert.deepEqual(relations(reset).map((r:any)=>r.relation),['recipient','audience']);
});
test('recipient alternatives ask a focused question, preserving source, product and budget',()=>{
 for(const suffix of ['for my uncle or my brother','for women or children','for our family or our household','for my uncle or for my brother']){
  const text='Find scarf '+suffix+' under $55',r=resolve(engine,text);assert.equal(r.status,'NEEDS_CONTEXT',text);assert.match(r.message,/Which recipient/);noActions(r);
  assert.equal(r.entities.productText,'scarf');assert.deepEqual(r.entities.price,{operator:'<',value:55,currency:'USD'});assert.equal(relations(r).length,0);
  const span=r.entities.shoppingContext.unresolved[0];assert.equal([...text].slice(span.start,span.end).join(''),span.text);
  const explanation=explainKnowledge(engine,text);assert.ok(explanation.evidence.some(x=>x.family==='relationship'&&x.ruleId.startsWith('for.')));
 }
});
test('explicit compatibility stays unresolved while preserving model evidence and the reviewed rule',()=>{
 for(const marker of ['compatible with','that works with','to use with']){
  const text='Find cable '+marker+' my iPhone 13 under $50',r=resolve(engine,text);assert.equal(r.status,'NEEDS_CONTEXT',text);noActions(r);assert.match(r.message,/compatibility specification/);
  assert.equal(r.entities.evidenceRequirements[0].kind,'named_device_compatibility');assert.equal(r.entities.compatible,undefined);assert.equal(relations(r).length,0);
  const e=r.entities.evidenceRequirements[0];assert.equal([...text].slice(e.start,e.end).join(''),e.text);
  assert.ok(explainKnowledge(engine,text).evidence.some(x=>x.version===2&&x.family==='relationship'));
 }
 const family=resolve(engine,'Find cable compatible with MacBook');assert.equal(family.status,'NEEDS_CONTEXT');assert.match(family.message,/Which exact MacBook model/);
 const negative=resolve(engine,'Find cable not compatible with iPhone 13');assert.equal(negative.status,'NEEDS_CONTEXT');assert.match(negative.message,/Which device/);assert.equal(negative.entities.evidenceRequirements,undefined);noActions(negative);
 assert.equal(resolve(engine,'Find charger for iPhone 13').status,'RESOLVED'); // Catalog search remains evidence-gated downstream.
});
test('new policies do not consume quoted identities or promote write requests',()=>{
 const quoted=resolve(engine,'Find "scarf for my family"');assert.equal(quoted.entities.shoppingContext,undefined);
 for(const text of ['Buy bread for my family','Add bread for my family to cart','Find scarf for my uncle or my brother and checkout']){
  const r=resolve(engine,text);assert.equal(r.entities.shoppingContext,undefined,text);
 }
 const unknown=resolve(engine,'Find charger compatible with iPhone 13 Pro Unlisted');assert.equal(unknown.entities.evidenceRequirements,undefined);assert.match(unknown.entities.productText,/unlisted/);
});
test('all original 28 Phase 2 expectations pass as regression, without changing their labels',()=>{
 const cases=read('../../../../output/enterprise-knowledge-phase2-20261010/validation-reserved.json').cases;
 const contains=(actual:any,want:any):boolean=>want&&typeof want==='object'?Object.entries(want).every(([key,value])=>contains(actual?.[key],value)):actual===want;
 for(const item of cases){let context:any={},last:any;for(const text of item.turns){last=resolve(engine,text,context);context=last.context.next;}
  const e=item.expected;for(const key of ['status','intent'])if(key in e)assert.equal(last[key],e[key],item.id+' '+key);
  for(const key of ['price','productText'])if(key in e)assert.ok(contains(last.entities[key],e[key]),item.id+' '+key);
  for(const row of e.relations??[])assert.ok(relations(last).some((r:any)=>contains(r,row)),item.id+' relation '+row.value);
  for(const row of e.absentRelations??[])assert.ok(!relations(last).some((r:any)=>contains(r,row)),item.id+' absent');
  if(e.needsClarification)assert.equal(last.status,'NEEDS_CONTEXT',item.id);
  if(e.noWrite)noActions(last);
  if(e.evidenceKind)assert.ok(last.entities.evidenceRequirements?.some((r:any)=>r.kind===e.evidenceKind),item.id);
 }
});
