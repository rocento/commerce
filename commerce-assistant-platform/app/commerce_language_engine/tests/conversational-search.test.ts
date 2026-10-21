import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {loadRuntime} from '../src/runtime.ts';
import {searchCommandCorrections} from '../src/search-language.ts';
import {tokenize} from '../src/semantic-clauses.ts';

const dictionary=buildExpandedDictionary();
// Exercise authored sources and the actual packaged dictionary independently.
for(const [name,c] of [['generated',compile(dictionary)],['packaged',await loadRuntime()]] as const){
 test(`${name}: reviewed conversational search heads retain the product and budget`,()=>{
  for(const prefix of ['', 'please ', 'could you ', 'can you ', 'pls ', 'would you ']){
   for(const head of ['I need','got any','I was hoping to buy']){
    const text=`${prefix}${head} copper fasteners under $20.50`;
    const r=resolve(c,text);
    assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_SEARCH',text);
    assert.equal(r.entities.productText,'copper fasteners',text);
    assert.deepEqual(r.entities.price,{operator:'<',value:20.5,currency:'USD'},text);
    assert.equal(r.text,text);
   }
  }
 });
 test(`${name}: independently authored phrasings and quantities`,()=>{
  for(const [text,product,quantity] of [
   ['I need coffee under $20.','coffee',undefined],
   ['Got any headphones?','headphones',undefined],
   ['I was hoping to buy running shoes.','running shoes',undefined],
   ['Have you got linen napkins?','linen napkins',undefined],
   ['We were hoping to buy three notebooks','notebooks',3],
   ['I am hoping to buy two copper fasteners','copper fasteners',2],
   ['We need four mugs','mugs',4],
   ['I need two shirts','shirts',2],
  ] as const){
   const r=resolve(c,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_SEARCH',text);
   assert.equal(r.entities.productText,product,text);assert.equal(r.entities.quantity,quantity,text);
  }
 });
 test(`${name}: all reviewed typo heads work only at the request command`,()=>{
  for(const prefix of ['', 'please ', 'could you please ', 'can you ', 'pls ', 'would you ', 'help me ']){
   for(const head of ['fnd','serch for','showw me','lok for','looking fr']){
    const text=`${prefix}${head} two serch headphones under $41`;
    const r=resolve(c,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_SEARCH',text);
    assert.equal(r.entities.productText,'serch headphones',text);assert.equal(r.entities.quantity,2,text);
    assert.equal(r.entities.catalogPurpose,undefined,text);
    assert.equal(r.entities.price.value,41,text);assert.equal(r.text,text);
    assert.equal(r.debug.searchCorrections.length,1,text);
    assert.ok(r.debug.matchedPhrases.some(m=>m.fuzzy),text);
   }
  }
 });
 test(`${name}: negation and incomplete or instructional requests never become searches`,()=>{
  for(const text of [
   "I don't need shoes",'I don’t need shoes','I need no shoes','I need not shoes',
   'I was not hoping to buy shoes','I was hoping not to buy shoes','never got any headphones',
   'do not fnd shoes',"don't serch for shoes",'never showw me shoes','please do not lok for shoes',
   'please I need help','I need assistance','I need customer support','I need technical assistance',
   'I need some help','I need some products','I need a refund','I need','got any','I was hoping to buy',
   'write a story about fnd shoes','translate I need shoes',
  ]){const r=resolve(c,text);assert.equal(r.status,'UNKNOWN',text);assert.equal(r.intent,null,text);}
 });
 test(`${name}: product names and SKU-like tokens are not autocorrected`,()=>{
  for(const product of ['fnd headphones','serch shoes','showw shirts','lok mugs','fr coffee','fnd-100 headphones','serch_100','serchlight lamps']){
   const r=resolve(c,`find ${product}`);assert.equal(r.intent,'PRODUCT_SEARCH',product);
   assert.equal(r.entities.productText,product.replace('_',' '),product);
   assert.equal(r.debug.searchCorrections.length,0,product);
  }
  const corrected=resolve(c,'fnd showw-100 headphones');
  assert.equal(corrected.entities.productText,'showw-100 headphones');
  for(const text of ['"fnd" headphones','fnd-100 headphones','serchlight lamps'])assert.equal(resolve(c,text).debug.searchCorrections.length,0,text);
 });
 test(`${name}: explicit actions and conflict handling survive conversational wrappers`,()=>{
  assert.equal(resolve(c,'I need to cancel my order').intent,'CANCEL_ORDER');
  assert.equal(resolve(c,'I need to add two shirts to my cart').intent,'ADD_TO_CART');
  for(const text of ['I need headphones. What would you suggest?','I need coffee under $50, safe for a severe peanut allergy. What would you suggest?']){
   const r=resolve(c,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,'PRODUCT_RECOMMEND',text);
  }
  for(const text of ['fnd shoes or cancel my order','I need shoes or cancel my order','got any shoes or cancel my order']){
   const r=resolve(c,text);assert.equal(r.status,'AMBIGUOUS',text);assert.equal(r.intent,null,text);
  }
 });
 test(`${name}: corrected search prepositions remain distinct from a later purpose`,()=>{
  for(const head of ['serch for','lok for','looking fr']){
   const plain=`   could you please ${head} three fnd lanterns under 30 euros?`;
   const result=resolve(c,plain);
   assert.equal(result.status,'RESOLVED',plain);
   assert.equal(result.entities.productText,'fnd lanterns',plain);
   assert.equal(result.entities.quantity,3,plain);
   assert.equal(result.entities.catalogPurpose,undefined,plain);
   assert.equal(result.entities.price.currency,'EUR',plain);
   const purposeful=resolve(c,`please ${head} lanterns for stargazing under $30`);
   assert.equal(purposeful.status,'RESOLVED',head);
   assert.equal(purposeful.entities.productText,'lanterns',head);
   assert.equal(purposeful.entities.catalogPurpose,'stargazing',head);
   assert.equal(purposeful.entities.price.value,30,head);
  }
 });
 test(`${name}: recommendation qualifiers remain evidence rather than merchant purposes`,()=>{
  const text='I need coffee under $50, safe for a severe peanut allergy. What would you suggest?';
  const result=resolve(c,text);
  assert.equal(result.intent,'PRODUCT_RECOMMEND');
  assert.equal(result.entities.productText,'coffee');
  assert.equal(result.entities.catalogPurpose,undefined);
  assert.deepEqual(result.entities.price,{operator:'<',value:50,currency:'USD'});
  assert.equal(result.entities.evidenceRequirements[0].kind,'allergy_safety');
  for(const span of result.entities.evidenceRequirements)assert.equal([...text].slice(span.start,span.end).join(''),span.text);
  for(const text of ["don't serch for shoes",'don’t lok for shoes','never serch for shoes']){
   const denied=resolve(c,text);
   assert.equal(denied.status,'UNKNOWN',text);
   assert.equal(denied.intent,null,text);
   assert.equal(denied.entities.catalogPurpose,undefined,text);
   assert.ok(!denied.operations?.includes('SEARCH_PRODUCTS'),text);
  }
 });
}

test('correction evidence and semantic token offsets refer to the original input',()=>{
 const text='Could you please fnd two serch headphones?';
 const [change]=searchCommandCorrections(text);
 assert.equal(text.slice(change.start,change.end),'fnd');assert.equal(change.to,'find');
 const tokens=tokenize(text);
 const command=tokens.find(t=>t.start===change.start)!;
 assert.equal(command.value,'find');assert.equal(text.slice(command.start,command.end),'fnd');
 assert.ok(tokens.some(t=>t.value==='serch'));
});

test('new search recognition does not depend on catalog membership',()=>{
 const empty=structuredClone(dictionary);empty.entity_terms=[];
 const a=compile(dictionary),b=compile(empty);
 for(const text of ['I need quasar widgets under $80','got any quasar widgets','please serch for quasar widgets']){
  const known=resolve(a,text),unknown=resolve(b,text);
  assert.equal(unknown.intent,'PRODUCT_SEARCH');assert.deepEqual(known.debug.candidates,unknown.debug.candidates);
 }
});
