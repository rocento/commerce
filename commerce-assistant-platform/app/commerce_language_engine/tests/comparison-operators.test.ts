import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadRuntime} from '../src/runtime.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {comparisonOperator,comparisonPhrasePattern} from '../src/comparison-operators.ts';
import {correctionPrice,correctionQuantity} from '../src/correction-numbers.ts';
import {acceptanceV3} from './acceptance-v3.ts';
import {extract} from '../src/entities.ts';

// Independently authored meanings, rather than targets derived from the map
// under test. Every existing price phrase keeps its supported syntax.
const phrases=[
 ['under','<'],['below','<'],['less than','<'],
 ['above','>'],['over','>'],['more than','>'],['greater than','>'],
 ['at most','<='],['up to','<='],['no more than','<='],
 ['at least','>='],['no less than','>='],['exactly','='],
] as const;
const boundaries=JSON.parse(await readFile(new URL('../../../tests/fixtures/comparison-boundaries.json',import.meta.url),'utf8')) as {
 amount:string;prices:string[];cases:{phrase:string;operator:string;symbol:string;accepted:string[]}[];
};

test('comparison phrases normalize spacing and longest overlapping wording wins',()=>{
 const pattern=new RegExp('\\b('+comparisonPhrasePattern()+')\\s+(\\d+)','gi');
 const matches=[...'no more than 100 and no less than 20'.matchAll(pattern)];
 assert.deepEqual(matches.map(match=>[match[1],comparisonOperator(match[1]),Number(match[2])]),[['no more than','<=',100],['no less than','>=',20]]);
 assert.equal(comparisonOperator('  NO  MORE\tTHAN  '),'<=');
 assert.equal(comparisonOperator('sometimes under'),undefined);
});

test('corrected authored price targets preserve the recorded acceptance baseline',async()=>{
 const baseline=JSON.parse(await readFile(new URL('./fixtures/acceptance-v3-baseline.json',import.meta.url),'utf8'));
 assert.equal(baseline.originalCorpusHash,'f28fe75caba166052cfd8008172183c29bb1498864ce6fdb0d7d83965f95fcbd');
 assert.equal(baseline.corpusHash,createHash('sha256').update(JSON.stringify(acceptanceV3)).digest('hex'));
 assert.deepEqual(baseline.targetCorrection.changes.map((change:{previous:string;corrected:string})=>[change.previous,change.corrected]),[['<=','<'],['>=','>']]);
 assert.equal(baseline.dictionaryVersion,2);
 assert.equal(baseline.count,50);
 assert.equal(baseline.intentCorrect,21);
 assert.equal(baseline.statusCorrect,22);
 assert.equal(baseline.predictions.length,50);
});

test('price correction words share operators while whole quantity parsing remains separate',()=>{
 for(const [phrase,operator] of phrases){
  const corrected=correctionPrice(`${phrase} one hundred euros`);
  assert.equal(corrected,`${phrase} EUR 100`);
  assert.equal(comparisonOperator(corrected!.slice(0,-8)),operator);
  assert.equal(correctionQuantity(`${phrase} three`),undefined);
 }
 assert.equal(correctionQuantity('three'),3);
 assert.equal(correctionQuantity('1.5'),undefined);
 assert.equal(correctionPrice('at least one hundred volts'),undefined);
});

for(const [name,runtime] of [['packaged',await loadRuntime()],['generated',compile(buildExpandedDictionary())]] as const){
 test(`${name}: independent cross-engine fixtures distinguish equal boundary prices`,()=>{
  for(const row of boundaries.cases){
   const text=`find mugs ${row.phrase} $${boundaries.amount}`;
   const result=resolve(runtime,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.entities.price.operator,row.symbol,text);
   const accepted=boundaries.prices.filter(price=>{
    const value=Number(price),limit=Number(boundaries.amount);
    switch(result.entities.price.operator){
     case '<':return value<limit;
     case '<=':return value<=limit;
     case '>':return value>limit;
     case '>=':return value>=limit;
     case '=':return value===limit;
     default:throw new Error(`Unexpected comparison: ${result.entities.price.operator}`);
    }
   });
   assert.deepEqual(accepted,row.accepted,text);
  }
 });
 test(`${name}: every supported price phrase has the intended strictness`,()=>{
  for(const [phrase,operator] of phrases){
   for(const amount of ['$100','EUR 100','100 GBP']){
    const text=`find mugs ${phrase} ${amount}`;
    const result=resolve(runtime,text);
    assert.equal(result.status,'RESOLVED',text);
    assert.equal(result.intent,'PRODUCT_SEARCH',text);
    assert.equal(result.entities.productText,'mugs',text);
    const currency=amount.startsWith('$')?'USD':amount.startsWith('EUR')?'EUR':'GBP';
    assert.deepEqual(result.entities.price,{operator,value:100,currency},text);
    assert.equal(result.entities.quantity,undefined,text);
   }
  }
 });
 test(`${name}: bounds joined with and remain one search with both original limits`,()=>{
  for(const text of ['find mugs greater than $20 and no more than $100','find mugs no less than $20 and under $100','find mugs at least $20 and at most $100']){
   const result=resolve(runtime,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.entities.productText,'mugs',text);
   assert.equal(result.entities.line_items,undefined,text);
   assert.equal(result.context.next.activeSearch?.text,text,text);
  }
 });
 test(`${name}: follow-up bound edits retain the opposite limit and exclusions`,()=>{
  const first=resolve(runtime,'find mugs greater than $20 and under $100');
  const upper=resolve(runtime,'make it no more than $80',first.context.next);
  assert.equal(upper.status,'RESOLVED');
  assert.match(upper.interpretationText!,/greater than \$20 and no more than \$80/);
  assert.deepEqual(upper.entities.price,{operator:'>',value:20,currency:'USD'});
  assert.deepEqual(resolve(runtime,upper.interpretationText!).entities,upper.entities);
  const lower=resolve(runtime,'make it no less than $30',first.context.next);
  assert.equal(lower.status,'RESOLVED');
  assert.match(lower.interpretationText!,/under \$100 and no less than \$30/);
  assert.deepEqual(lower.entities.price,{operator:'<',value:100,currency:'USD'});
  const excluding=resolve(runtime,'find mugs under $100 excluding Acme');
  const refined=resolve(runtime,'make it above $20',excluding.context.next);
  assert.equal(refined.status,'NEEDS_CONTEXT');
  assert.match(refined.interpretationText!,/under \$100 and above \$20.*excluding Acme/i);
  assert.equal(refined.entities.requestConstraints[0].value,'Acme');
 });
 test(`${name}: quoted comparisons and product name words stay literal`,()=>{
  for(const name of ['under $100','no more than 3','greater than 10','no less than 5','Under Armour shoes']){
   const result=resolve(runtime,`find "${name}"`);
   assert.equal(result.status,'RESOLVED',name);
   assert.equal(result.entities.productText,name.toLowerCase(),name);
   assert.equal(result.entities.price,undefined,name);
   assert.equal(result.entities.quantity,undefined,name);
  }
  const brand=resolve(runtime,'find Under Armour shoes at most $100');
  assert.equal(brand.entities.productText,'under armour shoes');
  assert.deepEqual(brand.entities.price,{operator:'<=',value:100,currency:'USD'});
 });
 test(`${name}: unit prices, basket conditions and cart quantities retain separate scope`,()=>{
  const search=resolve(runtime,'find three mugs above $20');
  assert.deepEqual(search.entities.price,{operator:'>',value:20,currency:'USD'});
  assert.equal(search.entities.quantity,3);
  for(const [subject,scope] of [['total','BASKET_TOTAL'],['line total','LINE_TOTAL'],['product price','UNIT_PRICE']] as const){
   const text=`add three mugs to cart only if the ${subject} is no more than $100`;
   const result=resolve(runtime,text);
   assert.equal(result.status,'NEEDS_CONTEXT',text);
   assert.equal(result.entities.price,undefined,text);
   assert.equal(result.entities.requestConstraints[0].scope,scope,text);
   assert.match(result.entities.requestConstraints[0].text,/no more than \$100/);
   assert.equal(result.fulfillment?.status,'NOT_EXECUTED',text);
  }
  assert.equal(resolve(runtime,'add three mugs to cart').entities.quantity,3);
  assert.notEqual(resolve(runtime,'add 1.5 mugs to cart').status,'RESOLVED');
 });
 test(`${name}: comparison wording does not leak into open attribute values`,()=>{
  for(const [phrase,operator] of phrases){
   const text=`find mugs material linen ${phrase} 100`;
   const result=resolve(runtime,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.product_meaning?.attributes?.material,'linen',text);
   assert.deepEqual(result.entities.price,{operator,value:100},text);
  }
  const named=resolve(runtime,'find mugs material under armour at most 100');
  assert.equal(named.product_meaning?.attributes?.material,'under armour');
  assert.deepEqual(named.entities.price,{operator:'<=',value:100});
 });
 test(`${name}: exact cart quantities do not become price constraints`,()=>{
  for(const text of ['add exactly 3 mugs to cart','remove exactly 3 mugs from cart']){
   const result=resolve(runtime,text);
   assert.equal(result.status,'RESOLVED',text);
   assert.equal(result.entities.quantity,3,text);
   assert.equal(result.entities.productText,'mugs',text);
   assert.equal(result.entities.price,undefined,text);
  }
  const aliases=runtime.dictionary.entity_terms;
  const bounded=extract('add exactly 3 mugs under $100',aliases);
  assert.equal(bounded.quantity,3);
  assert.deepEqual(bounded.price,{operator:'<',value:100,currency:'USD'});
  const range=extract('add exactly 3 or 5 mugs to cart',aliases);
  assert.deepEqual(range.quantityRange,{min:3,max:5});
  assert.equal(range.quantity,undefined);
  assert.equal(range.price,undefined);
  assert.notEqual(resolve(runtime,'add exactly 3 or 5 mugs to cart').status,'RESOLVED');
  assert.deepEqual(extract('find mugs exactly $3',aliases).price,{operator:'=',value:3,currency:'USD'});
  assert.deepEqual(extract('add exactly 3 usd mugs',aliases).price,{operator:'=',value:3,currency:'USD'});
  assert.equal(extract('add exactly 3m cables to cart',aliases).quantity,undefined);
  // This change is scoped to the already supported cart quantity grammar.
  assert.equal(resolve(runtime,'find exactly 3 mugs').status,'UNKNOWN');
 });
}
