import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {productArgument} from '../src/product-argument.ts';
const dictionary=buildExpandedDictionary(),compiled=compile(dictionary);
const products=['rug','chair','necklace','tires','strawberry','shampoo','quasar widgets','veltronic modules'];
test('catalog nouns are entities, never primary intent terms',()=>{
 for(const word of products){
  // Bare known categories now enter an explicit read-only fragment search.
  // Unknown product names still require a command; neither becomes a semantic intent term.
  const known=dictionary.entity_terms.some(t=>t.type==='CATEGORY'&&t.alias===word);
  assert.equal(resolve(compiled,word).intent,known?'PRODUCT_SEARCH':null,word);
  assert.ok(!dictionary.groups.some(g=>g.terms.includes(word)),word);
 }
 assert.ok(dictionary.entity_terms.some(t=>t.type==='CATEGORY'));
});
test('product argument extraction and scores are catalog independent',()=>{
 const empty=structuredClone(dictionary);empty.entity_terms=[];const withoutCatalog=compile(empty);
 for(const product of products)for(const [command,intent] of [['find','PRODUCT_SEARCH'],['compare','PRODUCT_COMPARE']] as const){
  const text=`${command} ${product}`,known=resolve(compiled,text),unknown=resolve(withoutCatalog,text);
  assert.equal(known.intent,intent,text);assert.equal(known.entities.productText,product,text);
  assert.equal(unknown.intent,intent,text);assert.equal(unknown.entities.productText,product,text);
  assert.deepEqual(known.debug.candidates,unknown.debug.candidates,text);
 }
});
test('cart relationships extract arbitrary direct objects and quantities',()=>{
 for(const product of ['rugs',...products]){
  const r=resolve(compiled,`add two ${product} to cart`);
  assert.equal(r.intent,'ADD_TO_CART');assert.equal(r.entities.quantity,2);assert.equal(r.entities.productText,product);
  const remove=resolve(compiled,`remove two ${product} from cart`);
  assert.equal(remove.intent,'REMOVE_FROM_CART');assert.equal(remove.entities.productText,product);
 }
});
test('structural objects and missing arguments do not become product searches',()=>{
 for(const text of ['find','compare','return','find my order'])assert.notEqual(resolve(compiled,text).intent,'PRODUCT_SEARCH',text);
 assert.equal(resolve(compiled,'cancel my order').intent,'CANCEL_ORDER');
 assert.equal(resolve(compiled,'return my order').intent,null);
});
test('compiler enforces separate catalog storage',()=>{
 const invalid=structuredClone(dictionary);
 invalid.groups.push({code:'CATEGORY_CUSTOM',category:'CATEGORY',terms:['custom catalog noun']});
 assert.throws(()=>compile(invalid),/must be stored in entity_terms/);
 const legacy=structuredClone(dictionary) as any;delete legacy.entity_terms;
 assert.throws(()=>compile(legacy),/Legacy dictionary/);
});

test('open product arguments retain unknown multiword names and quantities',()=>{
 for(const product of ['rugs','quasar widgets','veltronic modules']){
  const tokens=['find','two',...product.split(' ')];
  assert.deepEqual(productArgument(tokens,[{group:'ACTION_SEARCH',phrase:'find',start:0,end:1,negated:false,fuzzy:false}]),{productText:product,quantity:2});
 }
});
