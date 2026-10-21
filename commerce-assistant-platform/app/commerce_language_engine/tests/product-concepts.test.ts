import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {productConcepts} from '../src/product-concepts.ts';
import {compileProductConcepts,productMeaning} from '../src/product-meaning.ts';

for(const [name,c] of [['generated',compile(buildExpandedDictionary())],['packaged',await loadRuntime()]] as const){
 test(`${name}: generic concepts retain the existing merchant search text`,()=>{
  const search=resolve(c,'I need some green tea');
  assert.equal(search.status,'RESOLVED');
  assert.equal(search.product_meaning?.action,'catalog.search');
  assert.equal(search.product_meaning?.product_concept,'green tea');
  assert.deepEqual(search.product_meaning?.concept_path,['grocery','beverages','tea','green tea']);
  assert.equal(search.product_meaning?.attributes?.color,undefined);
  const branded=resolve(c,'show me Lipton green tea');
  assert.equal(branded.product_meaning?.product_concept,'green tea');
  assert.equal(branded.product_meaning?.raw_product_text,'Lipton green tea');
  assert.equal(branded.entities.productText,'lipton green tea');
  assert.equal(branded.entities.brand,undefined);
  const sized=resolve(c,'show me shampoo size family');
  assert.equal(sized.product_meaning?.attributes?.size,'family');
  const unseen=resolve(c,'show me Zorvanta ZX-91 green tea');
  assert.equal(unseen.product_meaning?.raw_product_text,'Zorvanta ZX-91 green tea');
  assert.equal(unseen.product_meaning?.product_concept,'green tea');
  assert.equal(unseen.entities.brand,undefined);
 });
 test(`${name}: packaged quantities reuse the existing cart grammar`,()=>{
  const result=resolve(c,'add two bottles of milk');
  assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'ADD_TO_CART');
  assert.equal(result.product_meaning?.action,'cart.add');assert.equal(result.product_meaning?.product_concept,'milk');
  assert.equal(result.product_meaning?.quantity,2);assert.equal(result.product_meaning?.unit,'bottle');
  assert.equal(result.fulfillment?.status,'NOT_EXECUTED');
  const large=resolve(c,'two large bottles of milk');
  assert.equal(large.product_meaning?.quantity,2);assert.equal(large.product_meaning?.unit,'bottle');
  assert.equal(large.product_meaning?.attributes?.size,'large');
  assert.equal(large.product_meaning?.action,undefined);
 });
 test(`${name}: noun-fragment meaning preserves constraints without inventing actions`,()=>{
  const cheap=resolve(c,'cheap green tea');
  assert.equal(cheap.product_meaning?.product_concept,'green tea');assert.equal(cheap.product_meaning?.price_preference,'low');
  const shoes=resolve(c,'black running shoes under $100');
  assert.equal(shoes.product_meaning?.product_concept,'running shoes');
  assert.equal(shoes.product_meaning?.attributes?.color,'black');
  assert.deepEqual(shoes.product_meaning?.price_constraint,{operator:'<',value:100,currency:'USD'});
 });
 test(`${name}: multiple products remain separate, and denied language stays non-actionable`,()=>{
  const result=resolve(c,'add two bottles of milk and three boxes of tea');
  assert.equal(result.product_meaning,undefined);
  assert.deepEqual(result.product_meanings?.map(m=>[m.product_concept,m.quantity,m.unit]),[['milk',2,'bottle'],['tea',3,'box']]);
  for(const text of ['do not add two bottles of milk','never add two bottles of milk','if it is free add two bottles of milk'])assert.equal(resolve(c,text).product_meaning,undefined,text);
  for(const text of ['add zero bottles of milk','add -2 bottles of milk','add 2.5 bottles of milk'])assert.notEqual(resolve(c,text).status,'RESOLVED',text);
  assert.equal(resolve(c,'show me شاي green tea').product_meaning,undefined);
  const unknown=resolve(c,'show me Zorvanta Blorple');
  assert.equal(unknown.product_meaning?.product_concept,undefined);
  assert.equal(unknown.entities.productText,'zorvanta blorple');
 });
}

test('all configured concepts and aliases resolve without merchant data',()=>{
 for(const concept of productConcepts().filter(node=>node.kind==='product')){
  for(const alias of [concept.name,...concept.aliases??[]])assert.equal(productMeaning(alias)?.concept_id,concept.id,alias);
 }
 for(const [text,concept,industry] of [['rice','rice','grocery'],['shampoos','shampoo','beauty'],['laptops','laptop','electronics'],['sandals','sandals','fashion']]){
  assert.equal(productMeaning(text)?.product_concept,concept);assert.equal(productMeaning(text)?.industry,industry);
 }
 assert.equal(productMeaning('teapot'),undefined);
 assert.equal(productMeaning('tea and milk')?.product_concept,undefined);
});

test('labeled attributes accept open English values and measurements',()=>{
 const meaning=productMeaning('milk flavor dragonfruit size family volume 750 ml');
 assert.equal(meaning?.attributes?.flavor,'dragonfruit');
 assert.equal(meaning?.attributes?.size,'family');
 assert.equal(meaning?.attributes?.volume,'750 ml');
 assert.equal(productMeaning('milk flavor dragonfruit')?.attributes?.flavor,'dragonfruit');
 assert.equal(productMeaning('shoes color sea glass')?.attributes?.color,'sea glass');
 assert.equal(productMeaning('shoes material hemp')?.attributes?.material,'hemp');
 assert.equal(productMeaning('laptop condition refurbished')?.attributes?.condition,'refurbished');
 assert.equal(productMeaning('rice 2 kg')?.attributes?.weight,'2 kg');
 assert.equal(productMeaning('milk 750 ml')?.attributes?.volume,'750 ml');
 assert.equal(productMeaning('eggs pack of 12')?.attributes?.pack_size,'12');
 assert.equal(productMeaning('black tea')?.attributes?.color,undefined);
});

test('adding concept data needs no parser branches and invalid hierarchies fail early',()=>{
 const extended=compileProductConcepts([...productConcepts(),{id:'oat-drink',name:'oat drink',kind:'product',parent:'beverages',aliases:['oat drinks']}]);
 assert.equal(productMeaning('oat drinks',null,{},extended)?.product_concept,'oat drink');
 assert.throws(()=>compileProductConcepts([...productConcepts(),productConcepts()[0]]),/Duplicate/);
 assert.throws(()=>compileProductConcepts([{id:'a',name:'a',kind:'product',parent:'missing'}]),/parent/);
 assert.throws(()=>compileProductConcepts([{id:'a',name:'a',kind:'product',parent:'b'},{id:'b',name:'b',kind:'product',parent:'a'}]),/cycle/);
 assert.throws(()=>compileProductConcepts([{id:'a',name:'tea',kind:'product'},{id:'b',name:'tea',kind:'product'}]),/Ambiguous/);
});
