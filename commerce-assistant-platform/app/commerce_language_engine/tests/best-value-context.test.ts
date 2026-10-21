import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {contextualShoppingSearch} from '../src/contextual-language.ts';
import type {LanguageKnowledgePack} from '../src/language-knowledge.ts';

const pack=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-v1.json',import.meta.url),'utf8')) as LanguageKnowledgePack;
const compiled=compile({...buildExpandedDictionary(),languageKnowledge:pack});

test('complete broad-value idioms retain their established read route',()=>{
 for(const text of [
  'show me the best value for money products',
  'Recommend the best value products',
  'please recommend best-value products',
  'suggest the best value items',
  '  Pls suggest me the best value for money items please!  ',
 ]){
  assert.equal(contextualShoppingSearch(compiled.languageKnowledge,text),undefined,text);
  const result=resolve(compiled,text);
  assert.equal(result.status,'RESOLVED',text);
  assert.ok(['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(result.intent??''),text);
  assert.equal(result.entities.shoppingContext,undefined,text);
  assert.equal(result.requiresConfirmation,false,text);
  assert.equal(result.requestType,undefined,text);
  assert.ok((result.operations??[]).every(operation=>operation==='SEARCH_PRODUCTS'),text);
 }
});

test('broad-value price and product-relation suffixes are not dropped',()=>{
 for(const suffix of ['under $20','for women','made in Egypt','for orbital simulation','per kilogram']){
  const text='show me the best value for money products '+suffix;
  const contextual=contextualShoppingSearch(compiled.languageKnowledge,text);
  assert.ok(contextual?.unresolved?.length,text);
  const result=resolve(compiled,text);
  assert.equal(result.status,'NEEDS_CONTEXT',text);
  assert.equal(result.entities.shoppingContext.unresolved[0].text,
   'for money products'+(suffix==='under $20'?'':' '+suffix),text);
  assert.deepEqual(result.operations,[],text);
  if(suffix==='under $20')assert.deepEqual(result.entities.price,{operator:'<',value:20,currency:'USD'});
 }
 for(const [text,relation,value] of [
  ['show me best value products for women','audience','woman'],
  ['show me best value products made in Egypt','origin_country','Egypt'],
 ]){
  const result=resolve(compiled,text);
  assert.equal(result.status,'RESOLVED',text);
  assert.ok(result.entities.shoppingContext.relations.some((r:any)=>r.relation===relation&&r.value===value),text);
 }
});

test('broad-value wording preserves independent exclusions and conditions',()=>{
 for(const [suffix,kind,value] of [
  ['without nuts','EXCLUSION','nuts'],
  ['if discounted','CONDITION','discounted'],
 ]){
  const text='show me the best value for money products '+suffix;
  const result=resolve(compiled,text);
  assert.equal(result.status,'NEEDS_CONTEXT',text);
  assert.ok(result.entities.requestConstraints.some((constraint:any)=>constraint.kind===kind&&constraint.value===value),text);
  assert.ok((result.operations??[]).every(operation=>operation==='SEARCH_PRODUCTS'),text);
 }
});

test('broad-value phrasing cannot suppress an explicit action or negation',()=>{
 for(const text of [
  'show me the best value for money products and add tea to cart',
  'show me the best value for money products. Add tea to cart.',
 ]){
  const result=resolve(compiled,text);
  assert.equal(result.requestType,'MULTI_ACTION',text);
  assert.notEqual(result.status,'RESOLVED',text);
 }
 const negated=resolve(compiled,'do not show me the best value for money products');
 assert.notEqual(negated.status,'RESOLVED');
 const quoted=resolve(compiled,'show me "best value for money products"');
 assert.equal(quoted.entities.productText,'best value for money products');
 assert.equal(quoted.entities.catalogPurpose,undefined);
});
