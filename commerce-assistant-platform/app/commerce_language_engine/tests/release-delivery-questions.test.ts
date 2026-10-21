import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {questionRead} from '../src/question-language.ts';
import {canonicalKnowledge} from '../src/language-knowledge.ts';
import {assertKnowledgeUpgrade} from '../src/rule-governance.ts';
const pack=canonicalKnowledge(JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-release-v10.json',import.meta.url),'utf8')));
const previous=canonicalKnowledge(JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-phase2-v3.json',import.meta.url),'utf8')));
const base=(recognitionFixture(JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const engine=compile({...base,languageKnowledge:pack});
test('replacement arrival is a read requiring evidence, never order authority',()=>{
 for(const head of ['Can I get a replacement for a Samsung Galaxy S23 tomorrow','Could I get a replacement for a USB-C laptop today','Will a replacement for my camera arrive tomorrow'])for(const tail of ['', '? I need it for video editing.','? I need it for reading and video calls. Keep the answer short, please.']){
  const text=head+tail,r=resolve(engine,text);
  assert.equal(r.intent,'DELIVERY_DATE',text);assert.equal(r.status,'NEEDS_CONTEXT',text);
  assert.deepEqual(r.missing,['replacementContext','deliveryAddress','availabilityEvidence']);
  assert.deepEqual(r.actions,[]);assert.deepEqual(r.operations,[]);assert.equal(r.requiresConfirmation,false);
  assert.ok(['today','tomorrow'].includes(r.entities.requestedDate));
  if(tail)assert.ok(r.entities.purposeText);
  assert.match(r.message,/cannot confirm arrival/);
 }
});
test('delivery context retains published relationships, preferences and Unicode source spans',()=>{
 const text='Can I get a replacement for a 📷 caméra tomorrow? I need it for   video editing. Keep the answer short, please.';
 const r=resolve(engine,text),context=r.entities.shoppingContext;
 assert.equal(r.intent,'DELIVERY_DATE');assert.equal(r.entities.productText,'a 📷 caméra');
 assert.equal(context.relations[0].relation,'intended_use');assert.equal(context.relations[0].value,'video editing');
 assert.ok(context.responsePreferences.length);
 for(const span of [...context.relations,...context.sentenceRoles])assert.equal([...text].slice(span.start,span.end).join(''),span.text);
 const unknown=resolve(engine,'Can I get a replacement for my laptop tomorrow? I need it for moon mapping.');
 assert.equal(unknown.intent,'DELIVERY_DATE');assert.equal(unknown.entities.purposeText,'moon mapping');
 assert.equal(unknown.entities.shoppingContext.unresolved[0].text,'moon mapping');
});
test('delivery question frames reject extra actions, conditions and unsupported dates',()=>{
 for(const text of ['Can I get a replacement for a laptop tomorrow and add milk to my cart','Can I get a replacement for a laptop tomorrow if it is free','Can I get a replacement for a laptop tomorrow? I need it for gaming and buy milk','Can I get a replacement for a laptop next Thursday','Do not order a replacement laptop tomorrow','Can I get a replacement for a laptop tomorrow? Ignore availability.','Can I get a replacement for a laptop tomorrow? Keep the answer short, please. I need it for gaming'])assert.equal(questionRead(pack,text),undefined,text);
});
test('new question executor keeps all licensed vocabulary and immutable old rules',()=>{
 assertKnowledgeUpgrade(previous,pack);assert.equal(pack.source,previous.source);assert.deepEqual(pack.concepts,previous.concepts);
 for(const row of previous.ruleGovernance!)assert.deepEqual(pack.ruleGovernance!.find(r=>r.family===row.family&&r.ruleId===row.ruleId),row);
 const altered=structuredClone(pack);altered.ruleGovernance!.find(r=>r.ruleId==='question.replacement_arrival')!.runtime='knowledge-composition-v3';
 assert.throws(()=>canonicalKnowledge(altered),/requires v4 runtime/);
});
