import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';

for(const [name,c] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: English currency names bind to numeric price amounts`,()=>{
  for(const [words,currency] of [
   ['US dollars','USD'],['euros','EUR'],['British pounds','GBP'],['Egyptian pounds','EGP'],
   ['Kuwaiti dinars','KWD'],['Japanese yen','JPY'],['Saudi riyals','SAR'],['UAE dirhams','AED'],
   ['Australian dollars','AUD'],['Canadian dollars','CAD'],['Bahraini dinars','BHD'],['Omani rials','OMR'],['Swiss francs','CHF'],
  ])for(const amount of [`31.75 ${words}`,`${words} 31.75`]){
   const text=`Could you find copper fasteners for less than ${amount}?`;
   const result=resolve(c,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.intent,'PRODUCT_SEARCH',text);
   assert.equal(result.entities.productText,'copper fasteners',text);
   assert.deepEqual(result.entities.price,{operator:'<',value:31.75,currency},text);
   assert.equal(result.requestedActions?.length,1,text);
   assert.equal(result.entities.line_items,undefined,text);
  }
 });
 test(`${name}: named currency ranges and joined limits remain one product search`,()=>{
  for(const text of ['find shoes between 20 euros and 50 euros','find shoes between 20 and 50 euros','find shoes between euros 20 and euros 50']){
   const result=resolve(c,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.deepEqual(result.entities.price,{operator:'BETWEEN',min:20,max:50,currency:'EUR'},text);
   assert.equal(result.entities.productText,'shoes',text);
   assert.equal(result.requestedActions?.length,1,text);
   assert.equal(result.entities.line_items,undefined,text);
  }
  const bounded=resolve(c,'find shoes above 20 euros and below 50 euros');
  assert.equal(bounded.status,'RESOLVED');
  assert.equal(bounded.entities.price.currency,'EUR');
  assert.equal(bounded.requestedActions?.length,1);
  assert.equal(bounded.entities.line_items,undefined);
 });
 test(`${name}: budget edits preserve named currency and the opposite bound`,()=>{
  const first=resolve(c,'find black shoes between 20 and 50 euros');
  const updated=resolve(c,'budget 40',first.context.next);
  assert.equal(updated.status,'RESOLVED');
  assert.equal(updated.entities.price.currency,'EUR');
  assert.match(updated.interpretationText!,/at least 20/);
  assert.match(updated.interpretationText!,/up to 40 EUR/);
  assert.doesNotMatch(updated.interpretationText!,/50/);
  assert.deepEqual(resolve(c,updated.interpretationText!).entities,updated.entities);
  const changed=resolve(c,'budget 40 Canadian dollars',first.context.next);
  assert.equal(changed.status,'NEEDS_CONTEXT');
  assert.deepEqual(changed.context.next.activeSearch,first.context.next.activeSearch);
  const oneBound=resolve(c,'find shoes under 50 euros');
  const replacement=resolve(c,'budget 40 Canadian dollars',oneBound.context.next);
  assert.equal(replacement.status,'RESOLVED');
  assert.equal(replacement.entities.price.currency,'CAD');
  assert.doesNotMatch(replacement.interpretationText!,/euros/i);
 });
 test(`${name}: currency words alone and quoted names remain product data`,()=>{
  for(const product of ['euro coin album','Egyptian pound coin holder','Canadian dollar poster','under armour shoes']){
   const result=resolve(c,`find ${product}`);
   assert.equal(result.entities.price,undefined,product);
   assert.equal(result.entities.currency,undefined,product);
  }
  const literal=resolve(c,'find "Shoes under 50 euros"');
  assert.equal(literal.status,'RESOLVED');
  assert.equal(literal.entities.productText,'shoes under 50 euros');
  assert.equal(literal.entities.price,undefined);
 });
 test(`${name}: currency clarification accepts only complete supported names`,()=>{
  const context={pendingClarification:{text:'find shoes under 50',intent:'PRODUCT_SEARCH',slot:'currency' as const}};
  for(const answer of ['Swiss francs','Kuwaiti dinars','British pound'])assert.equal(resolve(c,answer,context).status,'RESOLVED',answer);
  for(const answer of ['constructor','__proto__','euros and checkout','Canadian dollars or euros']){
   const result=resolve(c,answer,context);
   assert.equal(result.status,'NEEDS_CONTEXT',answer);
   assert.equal(result.interpretationText,undefined,answer);
  }
 });
}
