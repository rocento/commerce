import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {compileKnowledge,parseLanguageKnowledge} from '../src/language-knowledge.ts';
import {contextualShoppingSearch} from '../src/contextual-language.ts';
import {utteranceBudgetUpdate} from '../src/utterance-language.ts';
const pack=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-v1.json',import.meta.url),'utf8'));
const dictionary=(recognitionFixture(JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const engine=compile({...dictionary,languageKnowledge:pack}),index=compileKnowledge(pack);
function assertSpans(result:any,source:string){
 for(const span of [...result.relations,...(result.sentenceRoles??[])])assert.equal([...source].slice(span.start,span.end).join(''),span.text);
}

test('a separate shopping prompt reuses the laptop, budget and intended use',()=>{
 const first=resolve(engine,'I need a laptop for online classes and my limit is $10000?');
 for(const text of ['What should I look at?','What should I look at? Keep the answer short, please.']){
  const result=resolve(engine,text,first.context.next);
  assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'PRODUCT_SEARCH');
  assert.equal(result.entities.productText,'laptop');
  assert.deepEqual(result.entities.price,{operator:'<=',value:10000,currency:'USD'});
  assert.equal(result.entities.shoppingContext.relations[0].value,'online classes');
  assert.equal(result.searchUpdate,true);assert.ok(result.interpretationText);
  assertSpans(result.entities.shoppingContext,result.interpretationText!);
 }
});

test('shopping prompts require an active search and never consume extra actions',()=>{
 const missing=resolve(engine,'What should I look at?');
 assert.equal(missing.status,'NEEDS_CONTEXT');assert.deepEqual(missing.missing,['activeSearch']);
 const first=resolve(engine,'Find laptop under $10000');
 const unrelated=resolve(engine,'Hello',first.context.next);
 const stale=resolve(engine,'What should I look at?',unrelated.context.next);
 assert.equal(stale.status,'NEEDS_CONTEXT');assert.deepEqual(stale.missing,['activeSearch']);
 for(const text of ['What should I look at? Add it to my cart.','What should I look at? Only waterproof ones.','What should I look at? $200']){
  const result=resolve(engine,text,first.context.next);
  assert.notEqual(result.searchUpdate,true,text);
 }
});

test('reviewed sentence roles handle all nine original failed language examples',()=>{
 const examples=[
  ['I need a laptop for online classes and my limit is $40. What should I look at?',40,'online classes',[]],
  ['I need a laptop for online classes and my limit is $40. what should I look at? pls be honest about what you cannot verify.',40,'online classes',['uncertainty']],
  ['I need a laptop for online classes and my limit is $40. What should I look at? Keep the answer short, please.',40,'online classes',['short']],
  ['This is my first time buying here. I need a laptop for online classes and my limit is $40. What should I look at?',40,'online classes',[]],
  ['I need a laptop for online classes and my limit is $40. what should I look at? pls do not assume details I have not given you.',40,'online classes',['no_assumptions']],
  ['I am short on time. I need a laptop for video editing and my limit is $75. What should I look at? Please give me a practical starting point.',75,'video editing',['practical_start']],
  ['I am not sure what I need. I need a laptop for video editing and my limit is $75. What should I look at? Can you explain the tradeoffs?',75,'video editing',['tradeoffs']],
  ['I need a laptop for video editing and my limit is $75. what should I look at? pls be honest about what you cannot verify.',75,'video editing',['uncertainty']],
  ['I need a laptop for video editing and my limit is $75. What should I look at? Explain why each suggestion fits.',75,'video editing',['explain_fit']],
 ] as const;
 for(const [text,budget,use,preferences] of examples){
  const result=resolve(engine,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,'PRODUCT_SEARCH',text);
  assert.equal(result.entities.productText,'laptop',text);assert.deepEqual(result.entities.price,{operator:'<=',value:budget,currency:'USD'},text);
  assert.equal(result.entities.shoppingContext.relations.find((r:any)=>r.relation==='intended_use').value,use,text);
  assert.deepEqual(result.entities.shoppingContext.responsePreferences,preferences,text);assertSpans(result.entities.shoppingContext,text);
 }
});
test('natural budget changes keep intended use and literal response preferences through multiple turns',()=>{
 const original='This is my first time buying here. I need a laptop for online classes and my limit is $40. Keep the answer short, please. Explain why each suggestion fits.';
 let result=resolve(engine,original);
 for(const [text,value] of [['Actually my budget is $20 now. What would you change?',20],['My budget is now $25.50.',25.5],['I do not want to spend more than $30.',30]] as const){
  result=resolve(engine,text,result.context.next);
  assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,'PRODUCT_SEARCH');assert.equal(result.entities.productText,'laptop');
  assert.deepEqual(result.entities.price,{operator:'<=',value,currency:'USD'});
  assert.equal(result.entities.shoppingContext.relations[0].value,'online classes');
  assert.deepEqual(result.entities.shoppingContext.responsePreferences,['short','explain_fit']);
  assert.ok(result.interpretationText);assertSpans(result.entities.shoppingContext,result.interpretationText!);
 }
});
test('new answer preferences on a budget edit are added to the preserved search context',()=>{
 const prior=resolve(engine,'Find laptop for online classes under $40. Keep the answer short.');
 const result=resolve(engine,'My budget is $20 now. Can you explain the tradeoffs?',prior.context.next);
 assert.equal(result.status,'RESOLVED');assert.deepEqual(result.entities.shoppingContext.responsePreferences,['short','tradeoffs']);
 assert.equal(result.entities.shoppingContext.relations[0].value,'online classes');assertSpans(result.entities.shoppingContext,result.interpretationText!);
});
test('a natural budget edit cannot create a product search without prior product context',()=>{
 const result=resolve(engine,'Actually my budget is $20 now. What would you change?');
 assert.equal(result.status,'NEEDS_CONTEXT');assert.deepEqual(result.missing,['activeSearch']);assert.equal(result.entities.productText,undefined);
});
test('wrappers compose with decimal prices and country punctuation without changing source spans',()=>{
 for(const country of ['St. Helena','U.S. Virgin Islands']){
  const text=`I am short on time. Find shoes made in ${country} for my mother under $40.50. Keep the answer short.`;
  const result=resolve(engine,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.entities.price.value,40.5,text);
  assert.ok(result.entities.shoppingContext?.relations.some((r:any)=>r.relation==='origin_country'),text);assertSpans(result.entities.shoppingContext,text);
 }
 const plain=resolve(engine,'I am short on time. I need a laptop and my limit is $40.50. Keep the answer short.');
 assert.equal(plain.entities.productText,'laptop');assert.deepEqual(plain.entities.price,{operator:'<=',value:40.5,currency:'USD'});
});
test('unknown sentences, extra actions, quotes and safety restrictions are never removed',()=>{
 for(const text of [
  'I need a laptop for online classes under $40. Add it to my cart. Keep the answer short.',
  'I need a laptop for online classes under $40. It must be compatible with my phone. Keep the answer short.',
  'I need a laptop for online classes under $40. My limit is actually $90. Keep the answer short.',
  'I need a laptop for online classes under $40. Find shoes under $50. Keep the answer short.',
  'Find "Keep the answer short" for my mother.',
  "Find 'Keep the answer short' for my mother.",
  'I need medicine safe for my nut allergy. Keep the answer short.',
  'Keep the answer short $400. Find laptop for online classes.',
  'I am short on time. Keep the answer short.',
  'Keep the answer short.',
  'I am short on time. Buy a laptop for online classes.',
 ])assert.equal(contextualShoppingSearch(index,text),undefined,text);
 for(const text of ['Actually my budget is $20 now and buy it.','My budget is $20. Checkout.','My budget is $20 if delivery is free.','My budget is $20 or $30.','My budget is >$20.','My budget is <$20.','My budget is $20%.','My budget is ~$20.','My budget is $20 ✅.'])assert.equal(utteranceBudgetUpdate(index,text),undefined,text);
});
test('all declarative budget templates consume the complete amount slot',()=>{
 for(const rule of pack.utteranceRules.filter((rule:any)=>rule.role==='budget_update'))for(const template of rule.phrases){
  assert.equal(utteranceBudgetUpdate(index,template.replace('{amount}','$20.50')),'up to $20.50',template);
  assert.equal(utteranceBudgetUpdate(index,template.replace('{amount}','$20 and checkout')),undefined,template);
 }
});
test('utterance validation rejects duplicate meanings and invalid preference or template fields',()=>{
 for(const mutate of [
  (p:any)=>p.utteranceRules.push({...p.utteranceRules[0],id:'duplicate.rule'}),
  (p:any)=>p.utteranceRules.push({id:'invalid.slot',role:'budget_update',phrases:['budget is {amount} or {amount}']}),
  (p:any)=>p.utteranceRules.push({id:'invalid.preference',role:'response_preference',phrases:['something different'],preference:'buy'}),
  (p:any)=>p.utteranceRules.push({id:'invalid.background',role:'background',phrases:['i have $40']}),
 ]){const changed=structuredClone(pack);mutate(changed);assert.throws(()=>parseLanguageKnowledge(changed));}
});

test('reviewed ask-if preference is not an unknown purchase condition',()=>{
 const text='I need a laptop for data analysis and my budget is $850. Ask me if you need more details.';
 const result=resolve(engine,text);assert.equal(result.status,'RESOLVED');assert.equal(result.entities.requestConstraints,undefined);
 assert.deepEqual(result.entities.price,{operator:'<=',value:850,currency:'USD'});assert.deepEqual(result.entities.shoppingContext.responsePreferences,['no_assumptions']);
});
test('recommendation conversations also retain the active search across budget changes',()=>{
 for(const suffix of ['', '. Keep it short.']){
  const first=resolve(engine,'Recommend a laptop for online classes under $400'+suffix);
  assert.equal(first.intent,'PRODUCT_RECOMMEND');assert.ok(first.context.next.activeSearch);
  const result=resolve(engine,'My budget is $200 now.',first.context.next);
  assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'PRODUCT_RECOMMEND');
  assert.equal(result.entities.productText,'laptop');assert.deepEqual(result.entities.price,{operator:'<=',value:200,currency:'USD'});
  if(suffix)assert.deepEqual(result.entities.shoppingContext.responsePreferences,['short']);
 }
});
test('fallback search cannot silently consume later actions, quoted money or account edits',()=>{
 const extra=resolve(engine,'I need a laptop for online classes and my limit is $400. Also cancel my order.');
 assert.equal(extra.status,'NEEDS_CONTEXT');assert.ok(extra.missing?.includes('remainingActions'));assert.deepEqual(extra.operations,[]);
 const printed=resolve(engine,'I need a poster saying "my budget is $20 now".');
 assert.equal(printed.status,'RESOLVED');assert.equal(printed.entities.price,undefined);assert.equal(printed.entities.productText,'poster saying my budget is $20 now');
 const first=resolve(engine,'I need a laptop for online classes under $400.');
 const address=resolve(engine,'Change my address to 20 Main Street.',first.context.next);
 assert.notEqual(address.intent,'PRODUCT_SEARCH');assert.equal(address.entities.merchantAttributes,undefined);assert.equal(address.entities.price,undefined);
});

test('a reviewed recommendation question retains its established recommendation intent',()=>{
 for(const prompt of ['What would you suggest?','What do you recommend?','Any recommendations?']){
  const text='I need headphones. '+prompt+' Keep it brief.';
  const result=resolve(engine,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,'PRODUCT_RECOMMEND',text);
  assert.equal(result.entities.productText,'headphones');assert.deepEqual(result.entities.shoppingContext.responsePreferences,['short']);assertSpans(result.entities.shoppingContext,result.interpretationText??text);
 }
 const search=resolve(engine,'I need headphones. Explain why you recommend each one.');
 assert.equal(search.intent,'PRODUCT_SEARCH');assert.deepEqual(search.entities.shoppingContext.responsePreferences,['explain_fit']);
});

test('reviewed browsing fatigue and two-option requests preserve the shopping clauses',()=>{
 for(const [use,budget] of [['video editing',75],['working from home',120],['travel photography',200],['gaming',300]] as const){
  const text=`I have been browsing for ages and feel stuck. I need a laptop for ${use} and my limit is $${budget}. What should I look at? I would rather see two sensible options than a long list.`;
  const result=resolve(engine,text);
  assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,'PRODUCT_SEARCH');assert.equal(result.entities.productText,'laptop');
  assert.deepEqual(result.entities.price,{operator:'<=',value:budget,currency:'USD'});
  assert.deepEqual(result.entities.shoppingContext.responsePreferences,['two_options']);
  assert.equal(result.entities.shoppingContext.relations[0].value,use==='working from home'?'remote work':use);
  assertSpans(result.entities.shoppingContext,text);
 }
});

test('coordinated known uses retain both concepts and exact literal source evidence',()=>{
 for(const use of ['reading and video calls','reading and for video calls','reading and video calls and online classes']){
  const text=`I am not sure what I need. I need a laptop for ${use} and my limit is $450. What should I look at? Can you explain the tradeoffs?`;
  const result=resolve(engine,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.entities.productText,'laptop');
  assert.deepEqual(result.entities.price,{operator:'<=',value:450,currency:'USD'});
  const relations=result.entities.shoppingContext.relations;
  assert.deepEqual(relations.map((r:any)=>r.value),use.endsWith('online classes')?['reading','video calls','online classes']:['reading','video calls']);
  assert.equal(relations[0].text,'for reading');assert.ok(relations[1].text.startsWith('and '));
  assert.deepEqual(result.entities.shoppingContext.responsePreferences,['tradeoffs']);assertSpans(result.entities.shoppingContext,text);
 }
});

test('use coordination does not consume unknown requirements, implicit negations or extra actions',()=>{
 for(const text of [
  'Find laptop for reading and orbital simulations under $450.',
  'Find laptop for reading and not video calls under $450.',
  'Find laptop not for reading and video calls under $450.',
  'Find laptop for reading and checkout.',
  'Find laptop for reading or video calls under $450.',
 ]){
  const result=contextualShoppingSearch(index,text);
  assert.ok(!result||result.unresolved?.length,text);
 }
 for(const text of ['Find laptop for reading and women under $450.','Find laptop for reading and for women under $450.']){
  const result=contextualShoppingSearch(index,text);
  assert.equal(result?.unresolved,undefined);
  assert.deepEqual(result?.relations.map(relation=>[relation.relation,relation.value]),[['intended_use','reading'],['audience','woman']]);
 }
});

test('preference-only followups retain prior product, uses and price without inventing recommendations',()=>{
 for(const initial of [
  'I need a laptop for working from home and my limit is $120. What should I look at? I would rather see two sensible options than a long list.',
  'Recommend laptop for reading and video calls at most $450. I would rather see two sensible options than a long list.',
 ]){
  const first=resolve(engine,initial);
  let result=resolve(engine,'Can you explain why that fits what I asked for?',first.context.next);
  assert.equal(result.status,'RESOLVED');assert.equal(result.intent,first.intent);assert.equal(result.searchUpdate,true);
  assert.equal(result.entities.productText,first.entities.productText);assert.deepEqual(result.entities.price,first.entities.price);
  assert.deepEqual(result.entities.shoppingContext.relations.map((r:any)=>[r.relation,r.value]),first.entities.shoppingContext.relations.map((r:any)=>[r.relation,r.value]));
  assert.deepEqual(result.entities.shoppingContext.responsePreferences,['two_options','explain_fit']);
  assert.equal(result.entities.product_reference,undefined);assert.equal(result.entities.recommendationFollowup,undefined);
  assertSpans(result.entities.shoppingContext,result.interpretationText!);
  result=resolve(engine,'I am confused. Please ask me just one question to help narrow this down.',result.context.next);
  assert.equal(result.status,'RESOLVED');assert.equal(result.searchUpdate,true);
  assert.deepEqual(result.entities.shoppingContext.responsePreferences,['two_options','explain_fit','one_question']);
  assert.deepEqual(result.entities.price,first.entities.price);assertSpans(result.entities.shoppingContext,result.interpretationText!);
 }
});

test('response-only updates require an active search and consume every current sentence',()=>{
 const first=resolve(engine,'Find laptop for reading and video calls at most $450.');
 for(const text of ['Can you explain why that fits what I asked for?','I am confused. Please ask me just one question to help narrow this down.']){
  const result=resolve(engine,text);assert.equal(result.status,'NEEDS_CONTEXT',text);assert.deepEqual(result.missing,['activeSearch']);assert.equal(result.entities.productText,undefined);
 }
 for(const text of [
  'Can you explain why that fits what I asked for? Add it to my cart.',
  'Can you explain why that fits what I asked for? It must be safe for my allergy.',
  'Keep it short $450.',
  'I am confused. Find shoes.',
 ]){
  const result=resolve(engine,text,first.context.next);assert.notEqual(result.searchUpdate,true,text);assert.equal(result.interpretationText,undefined,text);
 }
 const next=resolve(engine,'Show my cart',first.context.next);
 const stale=resolve(engine,'Can you explain why that fits what I asked for?',next.context.next);
 assert.equal(stale.status,'NEEDS_CONTEXT');assert.deepEqual(stale.missing,['activeSearch']);
});

test('repeated response preferences deduplicate bounded conversation text',()=>{
 let result=resolve(engine,'Find laptop for reading and video calls at most $450. Keep it brief.');
 for(let turn=0;turn<20;turn++){
  result=resolve(engine,'Can you explain why that fits what I asked for?',result.context.next);
  assert.equal(result.status,'RESOLVED');assert.equal(result.searchUpdate,true);
  assert.deepEqual(result.entities.shoppingContext.responsePreferences,['short','explain_fit']);
  assert.equal(result.entities.shoppingContext.sentenceRoles.filter((r:any)=>r.ruleId==='response.explain_fit').length,1);
  assert.ok(result.context.next.activeSearch!.text.length<250);assertSpans(result.entities.shoppingContext,result.interpretationText!);
 }
});

test('a one-question request expires when the shopper answers or asks for an explanation',()=>{
 const first=resolve(engine,'Find laptop for reading and video calls at most $450. I would rather see two sensible options than a long list.');
 const question=resolve(engine,'I am confused. Please ask me just one question to help narrow this down.',first.context.next);
 assert.ok(question.entities.shoppingContext.responsePreferences.includes('one_question'));
 for(const followup of ['My budget is $500 now.','Can you explain why that fits what I asked for?']){
  const result=resolve(engine,followup,question.context.next);
  assert.equal(result.status,'RESOLVED');assert.equal(result.searchUpdate,true);
  assert.ok(!result.entities.shoppingContext.responsePreferences.includes('one_question'));
  assert.ok(result.entities.shoppingContext.responsePreferences.includes('two_options'));
  if(followup.startsWith('My budget'))assert.deepEqual(result.entities.price,{operator:'<=',value:500,currency:'USD'});
  else assert.ok(result.entities.shoppingContext.responsePreferences.includes('explain_fit'));
 }
 const again=resolve(engine,'My budget is $500 now. Please ask me just one question to help narrow this down.',question.context.next);
 assert.equal(again.status,'RESOLVED');assert.ok(again.entities.shoppingContext.responsePreferences.includes('one_question'));
});

test('a question preference alone cannot invent the issued question or bind a bare answer',()=>{
 const first=resolve(engine,'Find laptop for reading and video calls at most $450.');
 const question=resolve(engine,'I am confused. Please ask me just one question to help narrow this down.',first.context.next);
 // Only the action service's server-issued clarification knows which slot was
 // actually asked. History-only language input must state its budget edit.
 for(const text of ['$500','500 USD','yes','reading']){
  const result=resolve(engine,text,question.context.next);
  assert.notEqual(result.searchUpdate,true,text);
  assert.ok(result.status!=='RESOLVED'||!['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(result.intent??''),text);
 }
 const explicit=resolve(engine,'My budget is $500 now.',question.context.next);
 assert.equal(explicit.status,'RESOLVED');assert.equal(explicit.searchUpdate,true);
 assert.deepEqual(explicit.entities.price,{operator:'<=',value:500,currency:'USD'});
});
