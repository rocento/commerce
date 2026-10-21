import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {requestMeaning} from '../src/evaluation/requests.ts';
import {projectVocabulary,parseVocabularyPack,vocabularyDigest} from '../src/vocabulary-enrichment.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import type {Dictionary} from '../src/types.ts';
const pack=JSON.parse(await readFile(new URL('../data/english-vocabulary/commerce-v1.json',import.meta.url),'utf8'));
const review=JSON.parse(await readFile(new URL('../data/english-vocabulary/review-v1.json',import.meta.url),'utf8'));
const packaged=(recognitionFixture(JSON.parse(await readFile(new URL('../data/compiled.json',import.meta.url),'utf8')))) as Dictionary;

test('reviewed additive pack preserves existing meaning, provenance and idempotence',()=>{
 const snapshot=structuredClone(packaged), result=projectVocabulary(packaged,pack);
 assert.deepEqual(packaged,snapshot);assert.equal(result.added.length,23);
 assert.deepEqual(result.dictionary.intents,packaged.intents);
 assert.deepEqual(result.dictionary.entity_terms,packaged.entity_terms);
 assert.deepEqual(result.dictionary.actionFrames,packaged.actionFrames);
 const twice=projectVocabulary(result.dictionary,pack);
 assert.equal(twice.added.length,0);assert.deepEqual(twice.dictionary,result.dictionary);
 for(const term of result.added)assert.equal(result.dictionary.groups.find(g=>g.code===term.group)!.termMetadata![term.surface].enrichment!.reviewState,'approved');
});
for(const [name,base] of [['packaged',packaged],['generated',buildExpandedDictionary()]] as const){
 test(name+': reviewed aliases handle unseen wrappers, negation and quoted unknown products',()=>{
  const runtime=compile(projectVocabulary(base,pack).dictionary);
  for(const entry of review.groups)for(const term of entry.terms){
   for(const text of [`${entry.verb} ${term}`,`please could you ${entry.verb} ${term}?`,`would you ${entry.verb} ${term} please`]){
    const result=resolve(runtime,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,entry.intent,text);assert.equal(result.text,text);
   }
   assert.notEqual(resolve(runtime,`do not ${entry.verb} ${term}`).status,'RESOLVED',term);
   const text=`find "${term} nebularium"`, literal=resolve(runtime,text);
   assert.equal(literal.intent,'PRODUCT_SEARCH');assert.equal(literal.entities.productText,`${term} nebularium`);
  }
  for(const held of review.held)assert.ok(!runtime.dictionary.groups.find(g=>g.code===held.group)!.terms.includes(held.surface));
 });
 test(name+': existing canonical requests retain exact semantics',()=>{
  const before=compile(base),after=compile(projectVocabulary(base,pack).dictionary);
  const cases=buildExpandedDictionary().corpus;
  for(const item of cases)assert.deepEqual(requestMeaning(resolve(after,item.text,item.context)),requestMeaning(resolve(before,item.text,item.context)),item.text);
 });
}
test('unapproved, malformed, duplicate and orphan records cannot compile',()=>{
 for(const update of [{reviewState:'pending'},{language:'ar'},{scope:'tenant'},{revision:0},{terms:[]},{reviewedBy:''}])assert.throws(()=>projectVocabulary(packaged,{...pack,...update}));
 assert.throws(()=>parseVocabularyPack({...pack,extra:true}));
 assert.throws(()=>projectVocabulary(packaged,{...pack,terms:[pack.terms[0],pack.terms[0]]}),/Duplicate/);
 assert.throws(()=>projectVocabulary(packaged,{...pack,terms:[{...pack.terms[0],group:'MISSING',sense:'MISSING'}]}),/Unknown/);
 assert.throws(()=>projectVocabulary(packaged,{...pack,terms:[{...pack.terms[0],surface:'Return Guidelines'}]}),/Invalid/);
 const corrupt=projectVocabulary(packaged,pack).dictionary;
 const meta=corrupt.groups.find(g=>g.code===pack.terms[0].group)!.termMetadata![pack.terms[0].surface];
 (meta.enrichment as unknown as {reviewState:string}).reviewState='pending';
 assert.throws(()=>compile(corrupt),/Invalid vocabulary review/);
});
test('new ambiguous senses need explicit review and retain both owners',()=>{
 const first=pack.terms[0], other='OBJECT_PAYMENT_METHODS';
 const base=projectVocabulary(packaged,{...pack,terms:[first]}).dictionary;
 const second={...first,group:other,sense:other};
 assert.throws(()=>projectVocabulary(base,{...pack,terms:[second]}),/Unreviewed ambiguous/);
 const result=projectVocabulary(base,{...pack,terms:[{...second,sharedWith:[first.group]}]});
 assert.ok(result.dictionary.groups.find(g=>g.code===first.group)!.terms.includes(first.surface));
 assert.ok(result.dictionary.groups.find(g=>g.code===other)!.terms.includes(first.surface));
 const alias=packaged.entity_terms.find(t=>/^[a-z]+(?: [a-z]+)*$/.test(t.alias))!;
 assert.throws(()=>projectVocabulary(packaged,{...pack,terms:[{...first,surface:alias.alias}]}),/alias|ambiguous/);
});

test('review identity ignores JSON property and record order, but binds changed meaning',()=>{
 // Reorder top-level properties without dropping nested fields.
 const reverse=Object.fromEntries(Object.entries(pack).reverse());
 assert.equal(vocabularyDigest(parseVocabularyPack(reverse)),vocabularyDigest(parseVocabularyPack(pack)));
 assert.equal(vocabularyDigest(parseVocabularyPack({...pack,terms:[...pack.terms].reverse()})),vocabularyDigest(parseVocabularyPack(pack)));
 assert.deepEqual(projectVocabulary(packaged,{...pack,terms:[...pack.terms].reverse()}).dictionary,projectVocabulary(packaged,pack).dictionary);
 assert.notEqual(vocabularyDigest(parseVocabularyPack({...pack,revision:2})),vocabularyDigest(parseVocabularyPack(pack)));
});

test('both new meanings of a shared surface require review regardless of row order',()=>{
 const first=pack.terms[0],second={...first,group:'OBJECT_PAYMENT_METHODS',sense:'OBJECT_PAYMENT_METHODS',sharedWith:[first.group]};
 for(const terms of [[first,second],[second,first]])assert.throws(()=>projectVocabulary(packaged,{...pack,terms}),/Unreviewed ambiguous/);
 const terms=[{...first,sharedWith:[second.group]},second];
 assert.deepEqual(projectVocabulary(packaged,{...pack,terms}).dictionary,projectVocabulary(packaged,{...pack,terms:[...terms].reverse()}).dictionary);
});
