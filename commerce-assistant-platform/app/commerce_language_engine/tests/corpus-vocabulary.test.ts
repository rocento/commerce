import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {contextualShoppingSearch} from '../src/contextual-language.ts';
import {compileKnowledge,parseLanguageKnowledge,knowledgeTokens} from '../src/language-knowledge.ts';

const pack=parseLanguageKnowledge(JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-v1.json',import.meta.url),'utf8')));
const dictionary=(recognitionFixture(JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const engine=compile({...dictionary,languageKnowledge:pack});
const index=compileKnowledge(pack);

// These targets are independent dimensions from corpus.py, not full question
// memorization. A changed product noun and budget must compose with each target.
const deviceTargets=[
 ['an iPhone 13','iPhone 13',false],
 ['a Samsung Galaxy S23','Samsung Galaxy S23',false],
 ['a USB-C laptop','USB-C laptop',true],
 ['an older iPad','iPad',true],
 ['an Android tablet','Android tablet',true],
 ['a MacBook Air M1','MacBook Air M1',false],
 ['an iPhone 15','iPhone 15',false],
 ['a Windows laptop','Windows laptop',true],
 ['a Nintendo Switch','Nintendo Switch',true],
 ['a Bluetooth-only phone','Bluetooth-only phone',true],
 ['a MacBook Pro','MacBook Pro',true],
 ['a Canon camera','Canon camera',true],
 ['a gaming laptop','gaming laptop',true],
 ['a MacBook Air','MacBook Air',true],
 ['an iPad Pro','iPad Pro',true],
] as const;

test('corpus device targets preserve model uncertainty and never become product specifications',()=>{
 for(const [target,canonical,requiresModel] of deviceTargets){
  const concept=pack.concepts.find(c=>c.kind==='device'&&c.canonical===canonical)!;
  assert.ok(concept,target);
  assert.equal(concept.metadata?.requiresExactModel===true,requiresModel,target);
  assert.equal(concept.metadata?.requiresProductEvidenceForCompatibility,true,target);
  const text=`Find adapter for ${target} under $55.50. Keep it brief.`;
  const result=resolve(engine,text);
  assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,'PRODUCT_SEARCH',text);
  assert.equal(result.entities.productText,'adapter',text);
  assert.deepEqual(result.entities.price,{operator:'<',value:55.5,currency:'USD'},text);
  assert.equal(result.entities.evidenceRequirements?.[0]?.kind,requiresModel?'device_compatibility':'named_device_compatibility',text);
  assert.equal(result.entities.catalogPurpose,undefined,text);
  assert.equal(result.entities.compatible,undefined,text);
  for(const row of result.entities.evidenceRequirements??[])assert.equal([...text].slice(row.start,row.end).join(''),row.text,text);
 }
});

test('device family matches cannot consume extra model suffixes or safety conditions',()=>{
 for(const text of [
  'Find adapter for Samsung Galaxy S23 Ultra Unlisted.',
  'Find adapter for MacBook Air M1 Unlisted Edition.',
  'Find adapter for Nintendo Switch if it is certified safe.',
  'Find adapter for an older iPad and buy it.',
 ]){
  const result=resolve(engine,text);
  assert.ok(result.status!=='RESOLVED'||!result.entities.evidenceRequirements,text);
 }
});

test('new activity aliases compose with other uses without implying product requirements',()=>{
 for(const [surface,canonical] of [
  ['taking online classes','online classes'],
  ['college coursework','university assignments'],
  ['making music','music production'],
  ['virtual meetings','video calls'],
  ['telecommuting','remote work'],
  ['running my business','running a small business'],
  ['day-to-day use','daily use'],
 ] as const){
  const result=resolve(engine,`Find tablet for ${surface} and reading under $350.`);
  assert.equal(result.status,'RESOLVED',surface);
  assert.equal(result.entities.productText,'tablet',surface);
  assert.deepEqual(result.entities.shoppingContext.relations.map((r:any)=>[r.relation,r.value]),[['intended_use',canonical],['intended_use','reading']],surface);
  assert.equal(result.entities.catalogPurpose,undefined,surface);
  assert.equal(result.entities.evidenceRequirements,undefined,surface);
 }
 for(const phrase of ['reading and video calls','drawing and design']){
  const tokens=knowledgeTokens(phrase);
  assert.ok(!(index.byFirstToken.get(tokens[0])??[]).some(entry=>entry.tokens.join(' ')===tokens.join(' ')),phrase);
 }
});

test('published for marker retains recipient, activity, occasion and device distinctions',()=>{
 for(const [text,kind,value] of [
  ['Find headphones for my buddy','recipient','friend'],
  ['Find headphones for virtual meetings','intended_use','video calls'],
  ['Find headphones for a birthday','occasion','birthday'],
 ] as const){
  const result=contextualShoppingSearch(index,text);assert.ok(result,text);
  assert.deepEqual(result.relations.map(r=>[r.relation,r.value]),[[kind,value]],text);
 }
 const price=resolve(engine,'Find headphones for $50');
 assert.ok(!(price.entities.shoppingContext?.relations??[]).length);
 assert.equal(price.entities.price?.value,50);
});

test('reviewed backgrounds and lead-ins do not classify safety, conditions or actions as disposable text',()=>{
 const removable=pack.utteranceRules?.filter(rule=>['background','lead_in','search_prompt'].includes(rule.role)).flatMap(rule=>rule.phrases)??[];
 for(const phrase of ['what is safe','i have a fragrance allergy','my child has sensitive skin','only if it is in stock','can i return it','add it to my cart','do not buy it','keep both under {amount} total']){
  assert.ok(!removable.includes(phrase),phrase);
 }
 assert.ok(pack.utteranceRules?.some(rule=>rule.role==='background'&&rule.phrases.includes('i am comparing options')));
 for(const concept of pack.concepts.filter(c=>['activity','device'].includes(c.kind))){
  assert.ok(!('specifications' in (concept.metadata??{})),concept.id);
  assert.ok(!('compatibleProducts' in (concept.metadata??{})),concept.id);
 }
});
