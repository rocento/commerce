import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {englishVocabulary,englishVocabularySource,heldEnglishTerms} from '../src/generation/reviewed-english.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const dictionary=buildExpandedDictionary(),runtime=compile(dictionary);
test('admitted English aliases resolve to reviewed existing intents and retain provenance',()=>{
 let count=0;
 for(const entry of englishVocabulary){
  const group=dictionary.groups.find(g=>g.code===entry.group)!;
  for(const term of entry.terms){
   if(heldEnglishTerms.has(term)){assert.ok(!group.terms.includes(term));continue;}
   count++;assert.equal(group.termMetadata?.[term]?.source,englishVocabularySource);
   for(const prefix of ['', 'please ', 'could you ']){
    const text=prefix+entry.verb+' '+term;const result=resolve(runtime,text);
    assert.equal(result.intent,entry.intent,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.text,text);
   }
  }
 }
 assert.equal(count,58);
});
test('enriched phrases remain negatable and quoted products remain literal',()=>{
 for(const entry of englishVocabulary)for(const term of entry.terms){
  if(heldEnglishTerms.has(term))continue;
  assert.notEqual(resolve(runtime,'do not '+entry.verb+' '+term).status,'RESOLVED');
  const result=resolve(runtime,`find "${term}"`);
  assert.equal(result.intent,'PRODUCT_SEARCH');
  assert.equal(result.entities.productText,term);
 }
});
