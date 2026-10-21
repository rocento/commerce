import './recognition-test-context.ts';
import {rocentoIntentCodes} from '../src/rocento-capabilities.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {collectCorpus,caseKey} from '../src/generation/corpus.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {catalog} from '../src/catalog.ts';
const d=buildExpandedDictionary();const compiled=compile(d);
test('expanded canonical intents remain reachable with correct resolution status',()=>{assert.ok(d.intents.length===rocentoIntentCodes.size);for(const c of d.corpus){const r=resolve(compiled,c.text,c.context);const newlyContextual=c.difficulty==='CONTEXT_REQUIRED'&&r.status==='NEEDS_CONTEXT'&&!!r.primaryIntent;assert.ok(r.intent===c.intent||(newlyContextual&&c.intent===null),c.text);assert.ok(r.status===(c.status??'RESOLVED')||newlyContextual,c.text);}});
test('generation is reproducible, deduplicated, split-safe and category-compatible',()=>{
 const a=collectCorpus(d,2400),b=collectCorpus(d,2400);assert.deepEqual(a,b);assert.equal(new Set(a.cases.map(caseKey)).size,a.cases.length);
 const families=new Map<string,Set<string>>();
 for(const c of a.cases){assert.ok(c.source);assert.ok(c.split);const splits=families.get(c.templateFamily!)??new Set();splits.add(c.split!);families.set(c.templateFamily!,splits);
  if(c.source!=='constrained-catalog-v2')continue;
  const item=catalog.find(x=>x.category===c.entities?.category)!;assert.ok(item);
  if(c.entities?.color)assert.ok(item.colors?.includes(c.entities.color as string));
  if(c.entities?.size)assert.ok(item.sizes?.includes(c.entities.size as string));
  if(c.entities?.material)assert.ok(item.materials?.includes(c.entities.material as string));
 }
 assert.ok([...families.values()].every(s=>s.size===1),'template family leaks across splits');
 assert.equal(new Set(a.cases.filter(c=>c.source==='constrained-catalog-v2').map(c=>c.entities?.category)).size,catalog.length);
});
test('overlapping phrase patterns cannot inflate candidate confidence',()=>{const before=resolve(compiled,'find shoes');const copy=structuredClone(d);copy.patterns.push(...copy.patterns.filter(p=>p.intent==='PRODUCT_SEARCH'));const after=resolve(compile(copy),'find shoes');assert.equal(after.confidence,before.confidence);assert.equal(after.debug.candidates[0].score,before.debug.candidates[0].score);});
test('compiler rejects contradictory rules and unknown transition states',()=>{const a=structuredClone(d);a.intents[0].conditions.push({group:a.intents[0].conditions[0].group,kind:'DISQUALIFY',score:0});assert.throws(()=>compile(a),/Contradictory/);const b=structuredClone(d);b.transitions[0].states=['MADE_UP'];assert.throws(()=>compile(b),/Invalid transition/);});
test('new opposite-action conflicts abstain and mutations require confirmation',()=>{assert.equal(resolve(compiled,'add and remove shoes from cart').status,'AMBIGUOUS');assert.equal(resolve(compiled,'empty cart').requiresConfirmation,true);});
test('metallic adjective is a color for electronics and a material for jewelry',()=>{const phone=resolve(compiled,'find silver phones under $200');assert.equal(phone.entities.color,'silver');assert.equal(phone.entities.material,undefined);const ring=resolve(compiled,'find silver rings under $200');assert.equal(ring.entities.material,'silver');assert.equal(ring.entities.color,undefined);});
test('words inside category aliases do not invent attribute filters',()=>{assert.deepEqual(resolve(compiled,'find green tea under $50').entities,{category:'tea',productText:'green tea',price:{operator:'<',value:50,currency:'USD'}});assert.equal(resolve(compiled,'find denim jeans').entities.material,undefined);});
