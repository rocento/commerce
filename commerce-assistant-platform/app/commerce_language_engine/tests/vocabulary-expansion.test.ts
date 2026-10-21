import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {canonicalKnowledge,knowledgeHash} from '../src/language-knowledge.ts';
import {lexicalConcept} from '../src/lexical-knowledge.ts';
import {assertKnowledgeReviewed,assertKnowledgeUpgrade} from '../src/rule-governance.ts';
import type {ShoppingRelation} from '../src/contextual-language.ts';
const data=new URL('../data/knowledge/',import.meta.url);
const old=canonicalKnowledge(JSON.parse(readFileSync(new URL('shopping-en-phase2-v2.json',data),'utf8')));
const pack=canonicalKnowledge(JSON.parse(readFileSync(new URL('shopping-en-phase2-v3.json',data),'utf8')));
const base=(recognitionFixture(JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const engine=compile({...base,languageKnowledge:pack});
const relations=(r:ReturnType<typeof resolve>):ShoppingRelation[]=>r.entities.shoppingContext?.relations??[];

for(const [product,value,alias,budget] of [
 ['camera','macro photography','taking macro photographs',500],
 ['supplies','hand sewing','sewing by hand',75],
] as const)test(`canonical relationship scope takes precedence over open purpose: ${value}`,()=>{
 for(const wording of [value,alias])for(const suffix of ['',` under $${budget}`]){
  const text=`Find ${product==='camera'?'a ':''}${product} for ${wording}${suffix}`,r=resolve(engine,text);
  assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_SEARCH');assert.equal(r.entities.productText,product);
  assert.equal(r.entities.catalogPurpose,undefined);assert.deepEqual(relations(r).map(x=>[x.relation,x.value,x.negated]),[['intended_use',value,false]]);
  if(suffix)assert.deepEqual(r.entities.price,{operator:'<',value:budget,currency:'USD'});else assert.equal(r.entities.price,undefined);
  for(const relation of relations(r))assert.equal([...text].slice(relation.start,relation.end).join(''),relation.text);
  assert.deepEqual(r.actions??[],[]);
 }
 const negative=resolve(engine,`Find ${product} not for ${value} under $${budget}`);
 assert.equal(negative.status,'RESOLVED');assert.equal(negative.entities.catalogPurpose,undefined);
 assert.deepEqual(relations(negative).map(x=>[x.relation,x.value,x.negated]),[['intended_use',value,true]]);
 assert.deepEqual(negative.entities.price,{operator:'<',value:budget,currency:'USD'});
});
test('governed canonical uses preserve typed context through budget refinements',()=>{
 const first=resolve(engine,'Find a camera for macro photography under $500');
 const next=resolve(engine,'make it under $300',first.context.next);
 assert.equal(next.status,'RESOLVED');assert.equal(next.entities.catalogPurpose,undefined);assert.equal(next.entities.productText,'camera');
 assert.deepEqual(next.entities.price,{operator:'<',value:300,currency:'USD'});
 assert.deepEqual(relations(next).map(x=>[x.relation,x.value]),[['intended_use','macro photography']]);
 assert.deepEqual(resolve(engine,next.interpretationText!).entities,next.entities);
});
test('relationship precedence preserves established merchant purposes and gift semantics',()=>{
 for(const [text,purpose] of [['Milk for breakfast under $5','breakfast'],['A necklace for a wedding under $200','wedding'],['search for lanterns for stargazing under $30','stargazing']] as const){
  const r=resolve(engine,text);assert.equal(r.status,'RESOLVED');assert.equal(r.entities.catalogPurpose,purpose);assert.equal(r.entities.shoppingContext,undefined);
 }
 const gift=resolve(engine,'Find a gift for my mother');assert.equal(gift.status,'RESOLVED');assert.equal(gift.entities.giftContext.recipient,'my mother');assert.equal(gift.entities.shoppingContext,undefined);
 // An open purpose with no governed concept keeps the established merchant path.
 const merchant=compile({...base,languageKnowledge:undefined});
 assert.equal(resolve(merchant,'Find supplies for hand sewing').entities.catalogPurpose,'hand sewing');
});

test('expanded English forms are uniquely reachable, source-linked and preserve all prior forms and rules',()=>{
 assertKnowledgeReviewed(pack);assertKnowledgeUpgrade(old,pack);assert.deepEqual(pack.ruleGovernance,old.ruleGovernance);assert.deepEqual(pack.rules,old.rules);
 assert.ok(pack.concepts.length>3500);assert.deepEqual(engine.dictionary.entity_terms,base.entity_terms);
 for(const previous of old.concepts){const c=pack.concepts.find(c=>c.id===previous.id)!;assert.equal(c.canonical,previous.canonical);assert.ok(previous.aliases.every(a=>c.aliases.includes(a)));}
 for(const c of pack.concepts)for(const form of [c.canonical,...c.aliases]){
  assert.ok(!/\p{Script=Arabic}/u.test(form));assert.equal(lexicalConcept(engine.languageKnowledge,c.kind,form)?.id,c.id,form);
 }
 for(const c of pack.concepts.filter(c=>c.id.startsWith('product.wn31_'))){
  assert.equal(c.metadata?.usage,'lexical_annotation_only');assert.ok(c.metadata?.lexicalReview);assert.ok((c.metadata?.provenance as any).sourceSha256);
 }
 assert.ok(pack.source.includes('WordNet 3.1 Copyright 2011 by Princeton University'));
 assert.equal(lexicalConcept(engine.languageKnowledge,'product','gluten-free diet'),undefined);
});

for(const [product,phrase,value] of [
 ['microphone','recording audiobooks','audiobook recording'],
 ['camera','photographing products','product photography'],
 ['laptop','creating motion graphics','motion graphics'],
 ['scanner','scanning photographic slides','slide scanning'],
 ['headphones','mixing live audio','live audio mixing'],
 ['laptop','debugging software','software debugging'],
 ['tools','prototyping electronic circuits','circuit prototyping'],
 ['camera','taking macro photographs','macro photography'],
 ['supplies','making quilts','quilting'],
 ['tools','sewing by hand','hand sewing'],
 ['paint','painting with watercolours','watercolor painting'],
 ['tools','restoring furniture','furniture restoration'],
 ['tools','bike maintenance','bicycle maintenance'],
 ['supplies','growing plants indoors','indoor gardening'],
 ['tools','propagating plants','plant propagation'],
 ['tools','grooming dogs','dog grooming'],
 ['flour','baking sourdough bread','sourdough baking'],
 ['supplies','making fresh juice','juicing'],
 ['tools','frothing milk','milk frothing'],
 ['shoes','running on trails','trail running'],
 ['shoes','playing badminton','badminton'],
 ['supplies','wrapping presents','gift wrapping'],
] as const)test(`use wording: ${phrase} preserves product and budget`,()=>{
 const text=`Find ${product} for ${phrase} and my budget is $75`,r=resolve(engine,text);
 assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_SEARCH');assert.equal(r.entities.productText,product);
 assert.deepEqual(r.entities.price,{operator:'<=',value:75,currency:'USD'});
 assert.ok(relations(r).some(x=>x.relation==='intended_use'&&x.value===value));assert.deepEqual(r.actions??[],[]);
});
for(const [phrase,value] of [['stepmum','stepmother'],['foster parents','foster parent'],['lab partners','lab partner'],['dog sitter','dog sitter'],['bridesmaids','bridesmaid']] as const)test(`recipient: ${phrase} adds no inferred traits`,()=>{
 const r=resolve(engine,`Find a scarf for my ${phrase}`);assert.equal(r.status,'RESOLVED');assert.ok(relations(r).some(x=>x.relation==='recipient'&&x.value===value));
 assert.equal(r.entities.gender,undefined);assert.equal(r.entities.age,undefined);assert.deepEqual(r.actions??[],[]);
});
for(const [product,phrase,value] of [['cloth','microfibre','microfiber'],['scarf','merino-wool','merino wool'],['bowl','borosilicate glass','borosilicate glass'],['pan','carbon steel','carbon steel']] as const)test(`material: ${phrase} remains a requested constraint`,()=>{
 const r=resolve(engine,`Find ${product} made of ${phrase}`);assert.equal(r.status,'RESOLVED');assert.ok(relations(r).some(x=>x.relation==='material'&&x.value===value));assert.deepEqual(r.actions??[],[]);
});
test('source product senses annotate an exact noun without making catalog or compatibility claims',()=>{
 const before=compile({...base,languageKnowledge:old});
 for(const phrase of ['espresso maker','coffee urn','staple gun','samovar','cranberry juice']){
  const r=resolve(engine,'Find '+phrase);assert.equal(r.status,'RESOLVED',phrase);assert.equal(r.entities.productText,phrase);
  const c=lexicalConcept(engine.languageKnowledge,'product',phrase)!;assert.ok(c,phrase);assert.equal(r.product_meaning?.concept_id,c.id,phrase);
  assert.equal(r.entities.stock,undefined);assert.equal(r.entities.compatible,undefined);assert.deepEqual(r.actions??[],[]);
  assert.deepEqual(r.entities,resolve(before,'Find '+phrase).entities,'lexical annotations do not change entity authority');
 }
});
test('new wording composes across turns and negation never adds a positive use',()=>{
 const first=resolve(engine,'Find laptop for my lab partner for software debugging and my budget is between $180 and $720');assert.equal(first.status,'RESOLVED');
 const second=resolve(engine,'Same budget but for motion graphics',first.context.next);assert.equal(second.status,'RESOLVED');assert.deepEqual(second.entities.price,first.entities.price);
 assert.ok(relations(second).some(x=>x.relation==='recipient'&&x.value==='lab partner'));assert.ok(relations(second).some(x=>x.relation==='intended_use'&&x.value==='motion graphics'));assert.ok(!relations(second).some(x=>x.value==='software debugging'));
 for(const text of ['Find laptop not for motion graphics','Find gloves for latex allergy']){
  const r=resolve(engine,text);assert.deepEqual(r.actions??[],[],text);assert.ok(!relations(r).some(x=>x.relation==='intended_use'&&!x.negated),text);
 }
 const missing=resolve(engine,'Find camera for unknownnewactivity');assert.notEqual(missing.status,'RESOLVED');
});
test('review hashes cannot be retained after altering imported vocabulary or scope',()=>{
 for(const field of ['aliases','scope']){const altered=structuredClone(pack),c=altered.concepts.find(c=>c.id.startsWith('product.wn31_'))!;
  if(field==='aliases')c.aliases.push('unreviewed new form');else c.metadata!.usage='explicit_relationship_only';
  assert.throws(()=>canonicalKnowledge(altered),/stale lexical review/);
 }
 assert.notEqual(knowledgeHash(pack),knowledgeHash(old));
});

// Explicitly retain discovered scope limits; these are not counted as solved.
test('generic gift/material searches retain the existing unresolved semantic gap',()=>{
 for(const text of ['Find a gift for my stepmum','Find products made of carbon steel']){
  const r=resolve(engine,text);assert.equal(r.entities.shoppingContext,undefined);
 }
});
test('vocabulary never adds a write action to an explicit compound request',()=>{
 const before=compile({...base,languageKnowledge:old});
 const text='Find microphone for audiobook recording and checkout';
 assert.deepEqual(resolve(engine,text).actions,resolve(before,text).actions);
});
