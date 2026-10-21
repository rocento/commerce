import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {validContext} from '../src/context.ts';
import {parseLanguageKnowledge} from '../src/language-knowledge.ts';
import {recommendationReferenceFollowup} from '../src/utterance-language.ts';

const pack=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-v1.json',import.meta.url),'utf8'));
const dictionary=(recognitionFixture(JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const engine=compile({...dictionary,languageKnowledge:pack});

test('reviewed device names become compatibility evidence, never purposes or product specifications',()=>{
 for(const text of [
  'I need a charger for an iPhone 13. How do I avoid buying the wrong one?',
  'Find charger for iPhone 13',
  'I need a charger compatible with my iPhone 13.',
  'Find charger for Samsung Galaxy S24 at most $60. Keep it brief.',
 ]){
  const result=resolve(engine,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,'PRODUCT_SEARCH');
  assert.equal(result.entities.productText,'charger');assert.equal(result.entities.catalogPurpose,undefined);
  assert.equal(result.entities.evidenceRequirements[0].kind,'named_device_compatibility');
  for(const row of result.entities.evidenceRequirements)assert.equal([...text].slice(row.start,row.end).join(''),row.text);
  assert.ok(!(result.entities.shoppingContext?.relations??[]).some((row:any)=>['intended_use','compatibility_target'].includes(row.relation)));
  assert.equal(result.entities.compatible,undefined);
 }
});

test('an incomplete known device family asks for exact-model evidence without inventing a model',()=>{
 const text='I need a charger for my iPhone. How do I avoid buying the wrong one?';
 const result=resolve(engine,text);assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'PRODUCT_SEARCH');assert.equal(result.entities.productText,'charger');
 assert.deepEqual(result.entities.evidenceRequirements,[{kind:'device_compatibility',text:'for my iPhone',start:17,end:30}]);
 assert.equal(result.entities.catalogPurpose,undefined);
});

test('device exclusions retain their polarity and ask for the actual target with Unicode source spans',()=>{
 for(const text of [
  'I need a charger not for an iPhone 13. How do I avoid buying the wrong one?',
  'Find charger not compatible with my Samsung Galaxy S24. What should I look at?',
  'I’m looking for a charger not for my iPhone 13. How do I avoid buying the wrong one?',
 ]){
  const result=resolve(engine,text);assert.equal(result.status,'NEEDS_CONTEXT',text);assert.equal(result.intent,'PRODUCT_SEARCH');
  assert.equal(result.entities.productText,'charger');assert.equal(result.entities.evidenceRequirements,undefined);assert.match(result.message,/Which device/);
  for(const row of result.entities.shoppingContext.unresolved)assert.equal([...text].slice(row.start,row.end).join(''),row.text);
  assert.deepEqual(result.operations,[]);assert.deepEqual(result.actions,[]);
 }
});

test('compatibility enrichment retains unknown suffixes and cannot swallow writes or unrelated safety requirements',()=>{
 for(const text of [
  'Add charger for iPhone 13 to my cart.',
  'I need a charger for iPhone 13 and checkout.',
  'Find charger for iPhone 13 Pro Unlisted.',
  'Find charger for iPhone 13 if it is certified safe.',
  'I need a charger not for an iPhone 13. How do I avoid buying the wrong one?',
  'Find charger not compatible with my iPhone 13. What should I look at?',
  'Find charger not compatible with my Samsung Galaxy S24. What should I look at?',
  'Find "for iPhone 13".',
 ]){
  const result=resolve(engine,text);
  assert.ok(result.status!=='RESOLVED'||!result.entities.evidenceRequirements,text);
 }
 const ordinary=resolve(engine,'Can you charge my phone?');
 assert.equal(ordinary.entities.evidenceRequirements,undefined);
});

test('first-suggestion rejection is a grounded recommendation followup and never guesses a catalog identity',()=>{
 const first=resolve(engine,'I need a laptop for university assignments and my limit is $800. Keep it short.');
 for(const context of [{},first.context.next]){
  const result=resolve(engine,'I do not like the first suggestion. What is another option?',context);
  assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'PRODUCT_RECOMMEND');
  assert.equal(result.entities.recommendationFollowup,'different');assert.equal(result.entities.recommendationReference,'FIRST');
  assert.equal(result.entities.productText,'*');assert.equal(result.entities.excludedProducts,undefined);assert.equal(result.entities.product_id,undefined);
  assert.equal(result.searchUpdate,undefined);assert.equal(result.requiresConfirmation,false);
  if('activeSearch' in context)assert.deepEqual(result.context.next.activeSearch,first.context.next.activeSearch);
 }
});

test('reference followup recognition consumes whole reviewed forms and cannot become a write',()=>{
 for(const rule of pack.utteranceRules.filter((r:any)=>r.role==='recommendation_followup'))for(const text of rule.phrases)assert.equal(recommendationReferenceFollowup(engine.languageKnowledge,text),'FIRST',text);
 for(const text of [
  'I do not like the first suggestion. What is another option? Buy it.',
  'I do not like the first suggestion. What is another option under $500?',
  'I do not like the second suggestion. What is another option?',
  'Find "I do not like the first suggestion. What is another option?"',
 ])assert.equal(recommendationReferenceFollowup(engine.languageKnowledge,text),undefined,text);
});

test('serialized search context preserves soft intended use across repeated plain budget changes',()=>{
 let result=resolve(engine,'I need a laptop for running a small business and my limit is $1200.');
 for(const amount of [850,500,600]){
  const context=JSON.parse(JSON.stringify(result.context.next));assert.equal(validContext(context,engine.dictionary),true);
  result=resolve(engine,`My budget is $${amount} now.`,context);
  assert.equal(result.status,'RESOLVED');assert.equal(result.entities.catalogPurpose,undefined);
  assert.deepEqual(result.entities.price,{operator:'<=',value:amount,currency:'USD'});
  assert.equal(result.entities.shoppingContext.relations[0].value,'running a small business');
  assert.equal(result.context.next.activeSearch?.contextual,true);
 }
 const invalid={activeSearch:{text:'Find laptop',contextual:'true'}};assert.equal(validContext(invalid,engine.dictionary),false);
 const forged={activeSearch:{text:'Add charger for iPhone 13 to my cart.',contextual:true as const}};
 const guarded=resolve(engine,'My budget is $500 now.',forged);
 assert.notEqual(guarded.status,'RESOLVED');assert.deepEqual(guarded.operations??[],[]);
});

test('knowledge reference roles reject missing, misplaced and unsupported identity selectors',()=>{
 for(const rule of [
  {id:'bad.followup',role:'recommendation_followup',phrases:['choose something else']},
  {id:'bad.followup',role:'recommendation_followup',phrases:['choose something else'],reference:'ANY'},
  {id:'bad.background',role:'background',phrases:['this is different'],reference:'FIRST'},
 ])assert.throws(()=>parseLanguageKnowledge({...pack,utteranceRules:[...pack.utteranceRules,rule]}));
});
