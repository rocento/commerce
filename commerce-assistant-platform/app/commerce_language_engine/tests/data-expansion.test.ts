import './recognition-test-context.ts';
import {rocentoIntentCodes,compatibleCase} from '../src/rocento-capabilities.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {expansionIntents,expansionCases,expansionSource} from '../src/generation/data-expansion.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const d=buildExpandedDictionary(),c=compile(d);
test('new information intents require an action and the specific industry concept',()=>{
 for(const [intent,,phrases] of expansionIntents.filter(([code])=>rocentoIntentCodes.has(code)))for(const phrase of phrases.split('|')){
  assert.equal(resolve(c,'show '+phrase).intent,intent,phrase);
  assert.equal(resolve(c,'do not show '+phrase).status,'UNKNOWN',phrase);
  assert.equal(resolve(c,phrase).status,'UNKNOWN',phrase);
 }
});
test('partial request-prefix matches defer to explicit search actions',()=>{
 for(const phrase of ['could you find apples','could you search for hoodies','could you look for pulse oximeters']){const r=resolve(c,phrase);assert.equal(r.intent,'PRODUCT_SEARCH',phrase);assert.equal(r.status,'RESOLVED',phrase);}
});
test('new data covers all industries with authored positives and negatives',()=>{
 const cases=[...expansionCases()];assert.equal(cases.length,14490);
 assert.equal(d.intents.filter(i=>i.provenance===expansionSource).length,expansionIntents.filter(([code])=>rocentoIntentCodes.has(code)).length);
 assert.equal(new Set(expansionIntents.map(i=>i[1])).size,9);
 assert.equal(cases.filter(t=>t.status==='UNKNOWN').length,162);
 assert.ok(cases.every(t=>t.source===expansionSource&&t.split&&t.templateFamily));
});
