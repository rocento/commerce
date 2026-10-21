import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {courtesyCoreText,requestConstraints} from '../src/request-constraints.ts';
import {contextualShoppingSearch} from '../src/contextual-language.ts';

const pack=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-phase2-v3.json',import.meta.url),'utf8'));
const compiled=compile({...buildExpandedDictionary(),languageKnowledge:pack});

test('a detached leading feasibility courtesy retains the complete request and source positions',()=>{
 for(const text of ['if possible, show my cart','  IF POSSIBLE, please add two bottles to my cart']){
  const core=courtesyCoreText(text)!;
  assert.equal(core.length,text.length);
  assert.equal(core.trim(),text.slice(text.indexOf(',')+1).trim());
  assert.equal(requestConstraints(text).constraints.length,0);
 }
 for(const text of ['if possible','only if possible, add milk to cart','if possible before Friday, add milk to cart','find "if possible"','find milk if possible']){
  assert.equal(courtesyCoreText(text),undefined,text);
 }
});

test('courtesy cannot erase a subsequent real condition or exclusion',()=>{
 for(const text of ['if possible, add milk to cart only if delivery is free','if possible, find milk but not almond milk','if possible before Friday, add milk to cart']){
  const result=resolve(compiled,text);
  assert.equal(result.status,'NEEDS_CONTEXT',text);
  assert.ok(result.entities.requestConstraints?.length,text);
  const source=result.interpretationText??text;
  for(const constraint of result.entities.requestConstraints)assert.equal([...source].slice(constraint.start,constraint.end).join(''),constraint.text);
 }
 assert.equal(requestConstraints('find "if possible, without milk"').constraints.length,0);
});

test('polite negated commands do not become product exclusions or authorize a write',()=>{
 for(const text of ['can you please not show my cart','could you kindly not display my attributes','please do not add milk to my cart','can you please not pop two mangosteens in cart']){
  const result=resolve(compiled,text);
  assert.equal(result.status,'UNKNOWN',text);
  assert.equal(result.intent,null,text);
  assert.equal(result.entities.requestConstraints,undefined,text);
  assert.equal(result.operations?.length??0,0,text);
 }
 for(const text of ['find milk not almond milk','can you please find milk but not almond milk','find shoes without leather']){
  assert.equal(requestConstraints(text).constraints[0]?.kind,'EXCLUSION',text);
 }
});

test('complete collection commands retain quantities while noun uses of their verbs remain reads',()=>{
 for(const action of ['place','pop','include','toss','drop']){
  const text=`pls i need ${action} any two mangosteens in cart`;
  assert.equal(contextualShoppingSearch(compiled.languageKnowledge,text),undefined,text);
  const result=resolve(compiled,text);
  assert.equal(result.intent,'ADD_TO_CART',text);
  assert.equal(result.status,'RESOLVED',text);
  assert.equal(result.entities.quantity,2,text);
  assert.equal(result.entities.selection,'ANY_MATCHING',text);
  assert.equal(result.entities.productText,'mangosteens',text);
 }
 for(const [text,product] of [['find place mats for my mother','place mats'],['I need pop filters for podcasting','pop filters']]){
  const result=resolve(compiled,text);
  assert.equal(result.status,'RESOLVED',text);
  assert.equal(result.intent,'PRODUCT_SEARCH',text);
  assert.equal(result.entities.productText,product,text);
  assert.ok(result.entities.shoppingContext?.relations.length,text);
 }
});

test('collection wording with an unspecified product remains a clarification',()=>{
 const result=resolve(compiled,'pls i need pop any two fresh items in cart');
 assert.equal(result.intent,'ADD_TO_CART');
 assert.equal(result.status,'NEEDS_CONTEXT');
 assert.equal(result.entities.quantity,2);
 assert.equal(result.entities.selection,'ANY_MATCHING');
 assert.equal(result.entities.freshness,'fresh');
 assert.equal(result.entities.shoppingContext,undefined);
});

test('a legacy purpose cannot invent a positive search from a negated domain read',()=>{
 for(const text of ['never inspect my ready for collection','never check eligible for promotion','never check ready for pickup','please do not find milk for breakfast']){
  const result=resolve(compiled,text);
  assert.equal(result.status,'UNKNOWN',text);
  assert.equal(result.intent,null,text);
  assert.equal(result.entities.catalogPurpose,undefined,text);
  assert.equal(result.operations?.length??0,0,text);
 }
 const negativeUse=resolve(compiled,'find laptop not for gaming under $800');
 assert.equal(negativeUse.status,'RESOLVED');
 assert.equal(negativeUse.entities.shoppingContext.relations[0].negated,true);
 assert.equal(resolve(compiled,"Something I don't need to cook under $5").entities.catalogPurpose,'no cook');
});
