import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {compileKnowledge} from '../src/language-knowledge.ts';
import {budgetSentence,shoppingUtterance} from '../src/utterance-language.ts';
import {contextualShoppingSearch} from '../src/contextual-language.ts';

const pack=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-v1.json',import.meta.url),'utf8'));
const dictionary=(recognitionFixture(JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const engine=compile({...dictionary,languageKnowledge:pack}),index=compileKnowledge(pack);
const assertSpans=(context:any,text:string)=>{
 for(const span of [...context.relations,...context.sentenceRoles??[]])assert.equal([...text].slice(span.start,span.end).join(''),span.text);
};

test('complete standalone budgets compose with recipient relative clauses and response roles',()=>{
 for(const text of [
  'I am buying a phone for my mother, who mainly uses it for online classes. Budget $40.',
  'I am short on time. I am buying a phone for my mother, who mainly uses it for online classes. Budget $40. Please give me a practical starting point.',
  'Budget $40. I’m buying a phone for my sister, who mainly uses it for online classes. Keep it short.',
 ]){
  const result=resolve(engine,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,'PRODUCT_SEARCH',text);
  assert.equal(result.entities.productText,'phone',text);assert.deepEqual(result.entities.price,{operator:'<=',value:40,currency:'USD'},text);
  assert.ok(result.entities.shoppingContext.relations.some((row:any)=>row.relation==='recipient'));
  assert.ok(result.entities.shoppingContext.relations.some((row:any)=>row.relation==='intended_use'&&row.value==='online classes'));
  assertSpans(result.entities.shoppingContext,text);
 }
});

test('budget sentence amounts preserve decimals, currency and written-number grammar',()=>{
 for(const [budget,value,currency] of [['Budget of €40.50',40.5,'EUR'],['My limit is 400 Egyptian pounds',400,'EGP'],['I can spend forty dollars',40,'USD']] as const){
  const text='Find a laptop for remote lessons. '+budget+'. What should I look at?';
  const result=resolve(engine,text);assert.equal(result.status,'RESOLVED',text);
  assert.deepEqual(result.entities.price,{operator:'<=',value,currency},text);assert.equal(result.entities.productText,'laptop');
  assertSpans(result.entities.shoppingContext,text);
 }
 const plain=resolve(engine,'Find laptop. Budget $40.');
 assert.equal(plain.status,'RESOLVED');assert.equal(plain.entities.productText,'laptop');assert.deepEqual(plain.entities.price,{operator:'<=',value:40,currency:'USD'});
});

test('inline with-a-budget grammar preserves gift purpose and recipient rather than searching the whole sentence',()=>{
 const text='I need an anniversary gift for my mother with a budget of $15. What would you choose?';
 const result=resolve(engine,text);assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'PRODUCT_SEARCH');
 assert.deepEqual(result.entities.price,{operator:'<=',value:15,currency:'USD'});
 assert.equal(result.entities.giftContext.occasion,'anniversary');
 assert.equal(result.entities.shoppingContext.relations[0].value,'mother');assertSpans(result.entities.shoppingContext,text);
 for(const text of ['Find a laptop for gaming with our budget of $500.','Find a phone for my sister, with a limit of $90.']){
  const result=resolve(engine,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.entities.price.operator,'<=',text);
 }
});

test('a published budget template can be added independently of product and recipient grammar',()=>{
 const changed=structuredClone(pack);changed.utteranceRules.push({id:'budget.heldout',role:'budget_update',phrases:['the spending ceiling is {amount}']});
 const next=compileKnowledge(changed),text='Find laptop for online classes. The spending ceiling is $80.';
 assert.equal(shoppingUtterance(index,text)?.budget,undefined);
 assert.equal(shoppingUtterance(next,text)?.budget?.price,'up to $80');
 assert.equal(contextualShoppingSearch(next,text)?.coreText,'find laptop up to $80');
});

test('unknown budget qualifiers, competing amounts and extra clauses are never consumed as a limit',()=>{
 for(const budget of ['Budget $40 if delivery is free','Budget $40 or $50','Budget $40 and checkout','Budget >$40','Budget $40%','Budget 通話 $40','Budget $40 per month']){
  assert.equal(budgetSentence(index,budget),undefined,budget);
  assert.equal(contextualShoppingSearch(index,'Find laptop for online classes. '+budget+'.'),undefined,budget);
 }
 assert.equal(contextualShoppingSearch(index,'Find laptop for online classes under $40. Budget $50.'),undefined);
 assert.equal(contextualShoppingSearch(index,'Find laptop for online classes. Budget $40. Budget $50.'),undefined);
 assert.equal(contextualShoppingSearch(index,'Find laptop for online classes. Budget $40. It must be waterproof.'),undefined);
});

test('discourse clarification retains the proven query and price while requiring remaining context',()=>{
 const text='My mother hates heavy earrings. Show me something lightweight for under $15. I would rather see two sensible options than a long list.';
 const result=resolve(engine,text);assert.equal(result.status,'NEEDS_CONTEXT');assert.equal(result.intent,'PRODUCT_SEARCH');
 assert.deepEqual(result.entities.price,{operator:'<',value:15,currency:'USD'});
 assert.equal(result.entities.productText,'something lightweight');assert.equal(result.entities.category,'earrings');assert.equal(result.entities.quantity,undefined);
 assert.equal(result.context.next.activeSearch,undefined);assert.equal(result.context.next.pendingRequest,text);
});

test('a casual im-buying contraction preserves recipient, purpose and a separate budget',()=>{
 const text='im buying a phone for my mother, who mainly uses it for online classes. Budget $40. pls do not assume details I have not given you.';
 const result=resolve(engine,text);assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'PRODUCT_SEARCH');
 assert.equal(result.entities.productText,'phone');assert.deepEqual(result.entities.price,{operator:'<=',value:40,currency:'USD'});
 assert.deepEqual(result.entities.shoppingContext.relations.map((row:any)=>[row.relation,row.value]),[['recipient','mother'],['intended_use','online classes']]);
 assert.deepEqual(result.entities.shoppingContext.responsePreferences,['no_assumptions']);assertSpans(result.entities.shoppingContext,text);
});
