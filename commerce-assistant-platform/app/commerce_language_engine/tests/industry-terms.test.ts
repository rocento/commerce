import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {industryTerms} from '../src/generation/industry-terms.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {industries,entityTypes} from '../src/knowledge.ts';
import {extract} from '../src/entities.ts';
import {normalize} from '../src/normalize.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const d=buildExpandedDictionary();
test('every authored industry term extracts its intended canonical value',()=>{
 for(const t of industryTerms){assert.ok(industries.includes(t.industry));assert.ok(entityTypes.includes(t.type));assert.equal(extract(normalize('find '+t.alias),d.entity_terms)[t.type.toLowerCase()],t.value,t.industry+': '+t.alias);}
 for(const industry of industries)assert.ok(industryTerms.filter(t=>t.industry===industry).length>=15,industry);
});
test('new industry vocabulary does not change intent scores',()=>{
 const c=compile(d),empty=compile({...d,entity_terms:[]});
 for(const industry of industries.filter(i=>i!=='CORE')){
  const terms=industryTerms.filter(t=>t.industry===industry&&t.type==='CATEGORY');
  for(const t of terms)for(const prefix of ['find ','add two ']){
   const text=prefix+t.alias+(prefix.startsWith('add')?' to cart':'');
   const known=resolve(c,text),unknown=resolve(empty,text);
   assert.deepEqual(known.debug.candidates,unknown.debug.candidates,text);
   assert.equal(known.entities.category,t.value,text);
  }
 }
});
test('qualified aliases avoid common cross-industry collisions',()=>{
 for(const [text,category] of [['find car shampoo','car_shampoo'],['find hair shampoo','shampoo'],['find toner cartridge','toner_cartridge'],['find facial toner','facial_toner'],['find coffee table','coffee_table'],['find coffee','coffee'],['find hand cream','hand_cream']] as const)assert.equal(extract(text,d.entity_terms).category,category,text);
 assert.equal(extract('find orange colored hoodies',d.entity_terms).color,'orange');
 assert.equal(extract('find oranges',d.entity_terms).color,undefined);
});
