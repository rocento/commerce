import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {loadRuntime} from '../src/runtime.ts';
import {resolveAmbiguities,scopedEntityAliases} from '../src/reference-resolution.ts';
import type {Alias,SemanticAmbiguity} from '../src/types.ts';

for(const [name,runtime] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: explicit product categories resolve brand collisions without dropping filters`,()=>{
  for(const text of ['find Apple phones under $500','find red Apple phones under $500']){
   const result=resolve(runtime,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,'PRODUCT_SEARCH',text);
   assert.equal(result.entities.category,'phone',text);
   assert.equal(result.entities.brand,'Apple',text);
   assert.deepEqual(result.entities.price,{operator:'<',value:500,currency:'USD'},text);
   assert.equal(result.ambiguities?.[0]?.clarificationRequired,false,text);
   assert.equal(result.requiresConfirmation,false,text);
  }
  const crossStore=resolve(runtime,'find Apple phones',{industry:'GROCERY'});
  assert.equal(crossStore.status,'RESOLVED');
  assert.equal(crossStore.entities.category,'phone');
  assert.equal(crossStore.entities.brand,'Apple');
 });
 test(`${name}: declared material affinities survive alias deduplication`,()=>{
  assert.ok(runtime.dictionary.semanticModel?.ambiguities.some(a=>a.term==='silver'&&a.candidateRef==='MATERIAL:silver'&&a.industry==='JEWELRY'));
  for(const [text,field,category] of [
   ['find silver rings at most $100','material','ring'],
   ['find silver bracelets under $100','material','bracelet'],
   ['find silver phones at most $100','color','phone'],
  ]){
   const result=resolve(runtime,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,'PRODUCT_SEARCH',text);
   assert.equal(result.entities.category,category,text);
   assert.equal(result.entities[field],'silver',text);
   assert.equal(result.entities[field==='color'?'material':'color'],undefined,text);
   assert.equal(result.entities.price.operator,text.includes('at most')?'<=':'<',text);
   assert.equal(result.entities.price.value,100,text);
  }
 });
 test(`${name}: unresolved senses and independent items still ask for clarification`,()=>{
  for(const text of ['find apple','find silver','find silver shoes','find apple and phones','find apple, phones']){
   const result=resolve(runtime,text);
   assert.equal(result.status,'AMBIGUOUS',text);
   assert.equal(result.intent,null,text);
   assert.ok(result.ambiguities?.some(a=>a.clarificationRequired),text);
  }
  const sharedIndustry=resolve(runtime,'add banana to cart and remove apple from cart');
  assert.equal(sharedIndustry.status,'RESOLVED');
  assert.deepEqual(sharedIndustry.requestedActions?.map(action=>action.intent),['ADD_TO_CART','REMOVE_FROM_CART']);
 });
 test(`${name}: chosen lexical sense and extracted entity hints agree`,()=>{
  const electronics=resolve(runtime,'find apple',{industry:'ELECTRONICS'});
  assert.equal(electronics.status,'RESOLVED');
  assert.equal(electronics.entities.brand,'Apple');
  assert.equal(electronics.entities.category,undefined);
  const grocery=resolve(runtime,'find apple',{industry:'GROCERY'});
  assert.equal(grocery.status,'RESOLVED');
  assert.equal(grocery.entities.category,'apple');
  assert.equal(grocery.entities.brand,undefined);
 });
 test(`${name}: ordinal product wording retains existing result context requirements`,()=>{
  const context={previousIntent:'PRODUCT_SEARCH',states:['PRODUCT_RESULTS_VISIBLE'],resultSetItems:[{productText:'Milk'},{productText:'Bread'}]};
  for(const [text,ordinal] of [['Please pick the second product',2],['choose the first product',1],['pick the last one',-1]] as const){
   const result=resolve(runtime,text,context);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,'SELECT_PRODUCT',text);
   assert.equal(result.entities.ordinal,ordinal,text);
   assert.equal(result.requiresConfirmation,false,text);
   assert.notEqual(resolve(runtime,text).status,'RESOLVED',text);
  }
  for(const text of ['do not pick the second product','pick the second product and checkout','pick the second product if cheaper']){
   const result=resolve(runtime,text,context);
   assert.ok(result.intent!=='SELECT_PRODUCT'||result.status!=='RESOLVED',text);
  }
 });
}

test('collision rules use dictionary metadata for future catalog vocabulary',()=>{
 const entity_terms:Alias[]=[
  {type:'BRAND',value:'Pearl',alias:'pearl',industry:'CORE'},
  {type:'CATEGORY',value:'pearl',alias:'pearl',industry:'JEWELRY'},
  {type:'CATEGORY',value:'lamp',alias:'lamps',industry:'HOME'},
  {type:'COLOR',value:'red',alias:'red',industry:'FASHION'},
 ];
 const ambiguities:SemanticAmbiguity[]=entity_terms.slice(0,2).map(a=>({term:'pearl',candidateKind:'ENTITY_VALUE',candidateRef:a.type+':'+a.value,industry:a.industry,priorWeight:1,requiredContext:{industry:a.industry},disambiguationPolicy:'SCORE',version:1}));
 const dictionary={entity_terms,semanticModel:{ambiguities}};
 const result=resolveAmbiguities(dictionary,'find red Pearl lamps',{});
 assert.equal(result[0]?.clarificationRequired,false);
 assert.deepEqual(result[0]?.candidates.map(c=>c.kind+':'+c.value),['BRAND:Pearl']);
 assert.equal(scopedEntityAliases(dictionary,'find red Pearl lamps',{}).some(a=>a.type==='CATEGORY'&&a.alias==='pearl'),false);
 for(const text of ['find red pearl','find pearl and lamps'])assert.equal(resolveAmbiguities(dictionary,text,{})[0]?.clarificationRequired,true,text);
});
