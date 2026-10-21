import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {compileKnowledge} from '../src/language-knowledge.ts';
import {discourseProductIssue} from '../src/discourse-boundary.ts';
import {shoppingDiscourse} from '../src/utterance-language.ts';

const pack=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-v1.json',import.meta.url),'utf8'));
const index=compileKnowledge(pack);
const compiled=compile({...(recognitionFixture(JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8')))),languageKnowledge:pack});
const preference='I would rather see two sensible options than a long list.';

test('response style cannot become the product when substantive needs remain',()=>{
 for(const body of [
  'I am pregnant and have dry skin. Can you check whether a product is appropriate?',
  'My child has dry skin. Can I use adult skincare or should I choose something else?',
  'I have a fragrance allergy. What can you verify?',
  'I travel frequently. I cannot carry something heavy.',
 ]){
  const text=body+' '+preference;
  const result=resolve(compiled,text);
  assert.equal(result.status,'NEEDS_CONTEXT',text);assert.equal(result.intent,null,text);
  assert.equal(result.entities.productText,undefined,text);assert.equal(result.context.next.activeSearch,undefined,text);
  assert.equal(result.context.next.pendingRequest,text,text);assert.deepEqual(result.operations,[],text);assert.deepEqual(result.actions,[],text);
  assert.match(result.message,/needs|requirements/,text);
  if(body.includes('allergy'))assert.equal(result.entities.evidenceRequirements[0].kind,'allergy_safety');
 }
});

test('an unresolved multi-sentence need never seeds a later style followup with a fictional product',()=>{
 const text='My child has dry skin. Which product is suitable? '+preference;
 const first=resolve(compiled,text);
 const next=resolve(compiled,'What should I look at?',first.context.next);
 assert.notEqual(next.entities.productText,'sensible options than a long list');
 assert.equal(next.context.next.activeSearch,undefined);
});

test('complete searches with reviewed style/background wrappers retain normal routing',()=>{
 for(const text of ['Show me laptop. '+preference,'I am short on time. Show me laptop. Keep it short.','I need a laptop for online classes and my limit is $400. What should I look at? '+preference]){
  const result=resolve(compiled,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,'PRODUCT_SEARCH',text);assert.equal(result.entities.productText,'laptop',text);
 }
 const search=resolve(compiled,'Show me laptop');
 const followup=resolve(compiled,preference,search.context.next);
 assert.equal(followup.status,'RESOLVED');assert.equal(followup.entities.productText,'laptop');
});

test('coverage check is driven by reviewed roles and does not strip arbitrary text',()=>{
 const candidate={status:'RESOLVED',intent:'PRODUCT_SEARCH',entities:{productText:'sensible options than a long list'}};
 const text='I need help choosing. '+preference;
 assert.equal(discourseProductIssue(index,text,candidate),'response_as_product');
 const changed=structuredClone(pack);changed.utteranceRules=changed.utteranceRules.filter((rule:any)=>rule.preference!=='two_options');
 assert.equal(discourseProductIssue(compileKnowledge(changed),text,candidate),undefined);
 assert.equal(discourseProductIssue(index,'Show me laptop. Keep it short.',{...candidate,entities:{productText:'laptop'}}),undefined);
 assert.equal(discourseProductIssue(index,'My needs are unusual. Find laptop. Keep it short.',{...candidate,entities:{productText:'laptop'}}),'unparsed_sentences');
});


test('role normalization never erases an unknown word to manufacture a reviewed sentence',()=>{
 const parsed=shoppingDiscourse(index,'Show me laptop. Keep 通話 it short.');
 assert.equal(parsed?.sentenceRoles.length,0);
 assert.equal(parsed?.remaining.length,2);
});

test('unparsed needs retain the proven shopping query and budget rather than asking to start again',()=>{
 for(const style of ['Keep it short.','Please give me a practical starting point.','I would rather see two sensible options than a long list.']){
  const text='I am short on time. My mother hates heavy earrings. Show me something lightweight for under $15. '+style;
  const result=resolve(compiled,text);
  assert.equal(result.status,'NEEDS_CONTEXT',text);assert.equal(result.intent,'PRODUCT_SEARCH',text);
  assert.equal(result.entities.productText,'something lightweight',text);assert.equal(result.entities.category,'earrings',text);
  assert.deepEqual(result.entities.price,{operator:'<',value:15,currency:'USD'},text);
  assert.equal(result.entities.product_reference,undefined,text);
  assert.equal(result.context.next.pendingRequest,text,text);assert.equal(result.context.next.pendingClarification,undefined,text);
  assert.equal(result.context.next.activeSearch,undefined,text);assert.deepEqual(result.actions,[],text);assert.deepEqual(result.operations,[],text);
 }
});

test('an unquoted full question cannot become a product noun phrase on a resolved or unresolved search',()=>{
 for(const text of [
  'I want a complete luxury routine for dry skin for only $8. What is realistic?',
  'I want a complete luxury routine for easily irritated skin for only $60. What is realistic?',
  'I need a fancy dinner for 1, no cooking, and a total budget of $8. Is that realistic?',
 ]){
  const result=resolve(compiled,text);assert.equal(result.status,'NEEDS_CONTEXT',text);assert.equal(result.intent,'PRODUCT_SEARCH',text);
  assert.equal(result.entities.productText,undefined,text);assert.ok(result.entities.price,text);
  assert.deepEqual(result.actions,[],text);assert.deepEqual(result.operations,[],text);assert.equal(result.context.next.activeSearch,undefined,text);
  assert.equal(result.context.next.pendingClarification,undefined,text);
 }
});

test('exact quoted product titles retain question-like wording as literal identity',()=>{
 for(const title of ['What Is Realistic?','Show Me Love','How to Train Your Dragon']){
  const result=resolve(compiled,'Find "'+title+'"');assert.equal(result.status,'RESOLVED',title);assert.equal(result.intent,'PRODUCT_SEARCH',title);
  assert.equal(result.entities.productText,title.toLowerCase().replace(/\?$/,''),title);
 }
});
