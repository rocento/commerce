import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {searchCases} from '../src/generation/search-cases.ts';
const dictionary=buildExpandedDictionary(),compiled=compile(dictionary);

test('generated everyday search requests preserve filters and distinguish other actions',()=>{
 for(const example of searchCases()){
  const result=resolve(compiled,example.text);
  assert.equal(result.status,example.status,example.text);
  assert.equal(result.intent,example.intent,example.text);
  for(const [key,value] of Object.entries(example.entities??{}))assert.deepEqual(result.entities[key],value,example.text+' / '+key);
 }
});
test('show search evidence is independent of catalog membership and filter values',()=>{
 const empty=structuredClone(dictionary);empty.entity_terms=[];const withoutCatalog=compile(empty);
 for(const text of ['show me black running shoes under 3000','show me quasar widgets under 3000']){
  const known=resolve(compiled,text),unknown=resolve(withoutCatalog,text);
  assert.equal(known.intent,'PRODUCT_SEARCH');assert.equal(unknown.intent,'PRODUCT_SEARCH');
  assert.deepEqual(known.debug.candidates,unknown.debug.candidates);
 }
 assert.equal(resolve(compiled,'show me shoes').debug.score,resolve(compiled,'show me black shoes under 3000').debug.score);
});
test('a size guide concept remains required despite the SIZE prefix in its name',()=>{
 const result=resolve(compiled,'show me shoes');
 const candidate=result.debug.candidates.find(c=>c.intent==='PRODUCT_SIZE_GUIDE')!;
 assert.ok(candidate.missing.length>0);
 assert.equal(resolve(compiled,'show me a size chart').intent,'PRODUCT_SIZE_GUIDE');
});
