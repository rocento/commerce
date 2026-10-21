import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evidenceRequirements} from '../src/evidence-requirements.ts';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
const compiled=await loadRuntime();

test('requirement spans retain literal text and Unicode offsets',()=>{
 for(const text of ['I need tea safe for a severe peanut allergy','Find cream suitable during pregnancy','Find a cable compatible with my old device','Find food without animal-derived ingredients','Find milk delivered tomorrow before 9am','Find rice, the best value for a family of five','🙂 Find tea safe for my peanut allergy']){
  const rows=evidenceRequirements(text);assert.ok(rows.length,text);
  for(const r of rows)assert.equal([...text].slice(r.start,r.end).join(''),r.text);
 }
});
test('quoted names and ordinary product searches do not acquire requirements',()=>{
 for(const text of ['find "safe for a severe peanut allergy"','find Vegan Shoes','find Family Five SKU-123','find headphones under $20'])assert.deepEqual(evidenceRequirements(text),[]);
});
test('searches carry evidence requirements without upgrading negation or actions',()=>{
 const r=resolve(compiled,'I need coffee under $20, safe for a severe peanut allergy. What would you suggest?');
 assert.equal(r.status,'RESOLVED');assert.equal(r.entities.evidenceRequirements[0].kind,'allergy_safety');
 for(const text of ["I don't need coffee safe for a severe peanut allergy",'add coffee safe for a severe peanut allergy to my cart','find coffee then checkout']){
  const r=resolve(compiled,text);assert.equal(r.entities.evidenceRequirements,undefined,text);
 }
});
test('named models and manufacturing exclusions carry literal evidence spans',()=>{
 for(const [text,kind] of [
  ['find jackets under $2959 compatible with my Nova-47446','named_device_compatibility'],
  ['find cables compatible with the Orion X7','named_device_compatibility'],
  ['find measuring cups under $1547, excluding anything made in a factory','manufacturing_method'],
  ['find mugs without factory-made products','manufacturing_method'],
 ]){
  const r=resolve(compiled,text);assert.equal(r.status,'RESOLVED',text);
  const rows=r.entities.evidenceRequirements as ReturnType<typeof evidenceRequirements>;assert.ok(rows?.some(row=>row.kind===kind),text);
  for(const row of rows)assert.equal([...text].slice(row.start,row.end).join(''),row.text);
 }
 const incomplete='find bowls that must be handmade';
 assert.equal(evidenceRequirements(incomplete)[0].kind,'manufacturing_method');
 assert.equal(resolve(compiled,incomplete).status,'NEEDS_CONTEXT');
 for(const text of ['find "compatible with my Nova-47446"','find "must be handmade"','find Nova-47446 cases','find Factory-2026 mugs'])assert.deepEqual(evidenceRequirements(text),[],text);
});
