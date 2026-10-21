import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {buildKnowledge} from '../src/knowledge.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {contextualShoppingSearch} from '../src/contextual-language.ts';
import {compileKnowledge,type LanguageKnowledgePack} from '../src/language-knowledge.ts';

const pack:LanguageKnowledgePack={schemaVersion:1,id:'test-contextual-en',revision:1,language:'en',source:'Inline regression vocabulary',concepts:[
 {id:'activity.online-classes',kind:'activity',canonical:'online classes',aliases:['remote lessons']},
 {id:'activity.gaming',kind:'activity',canonical:'gaming',aliases:[]},
 {id:'person.mother',kind:'person',canonical:'mother',aliases:['mom','mum'],metadata:{personRole:'recipient'}},
 {id:'person.woman',kind:'person',canonical:'women',aliases:['woman','women\'s'],metadata:{personRole:'audience'}},
 {id:'occasion.birthday',kind:'occasion',canonical:'birthday',aliases:[]},
 {id:'color.blue',kind:'color',canonical:'blue',aliases:['navy blue']},
 {id:'color.red',kind:'color',canonical:'red',aliases:[]},
 {id:'color.orange',kind:'color',canonical:'orange',aliases:[],metadata:{ambiguous:true,requiresContext:true}},
 {id:'country.egypt',kind:'country',canonical:'Egypt',aliases:[],metadata:{code:'EG'}},
 {id:'country.us',kind:'country',canonical:'United States',aliases:['USA','US'],metadata:{code:'US',requiresContext:true}},
],rules:[
 {id:'for-activity',marker:'for',targetKind:'activity',relation:'intended_use',scope:'product',priority:100},
 {id:'for-recipient',marker:'for',targetKind:'person',relation:'recipient',scope:'product',priority:100,targetMetadata:{personRole:'recipient'}},
 {id:'for-audience',marker:'for',targetKind:'person',relation:'audience',scope:'product',priority:100,targetMetadata:{personRole:'audience'}},
 {id:'for-occasion',marker:'for',targetKind:'occasion',relation:'occasion',scope:'product',priority:100},
 {id:'for-country',marker:'for',targetKind:'country',relation:'market_country',scope:'product',priority:90},
 {id:'from-country',marker:'from',targetKind:'country',relation:'origin_country',scope:'product',priority:100},
 {id:'made-in-country',marker:'made in',targetKind:'country',relation:'origin_country',scope:'product',priority:120},
 {id:'shipping-to-country',marker:'shipping to',targetKind:'country',relation:'destination_country',scope:'delivery',priority:120},
 {id:'in-color',marker:'in',targetKind:'color',relation:'color',scope:'product',priority:100},
 {id:'color-modifier',marker:'modifier',targetKind:'color',relation:'color',scope:'product',priority:100},
 {id:'audience-modifier',marker:'modifier',targetKind:'person',relation:'audience',scope:'product',priority:100,targetMetadata:{personRole:'audience'}},
]};
const index=compileKnowledge(pack);
const compiled=compile({...buildKnowledge(),languageKnowledge:pack});

test('multiple for phrases resolve recipient and intended use with the complete budget',()=>{
 const text='I am looking for a laptop for my mother for online classes and my limit is $400.';
 const result=resolve(compiled,text);
 assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'PRODUCT_SEARCH');
 assert.equal(result.entities.productText,'laptop');
 assert.deepEqual(result.entities.price,{operator:'<=',value:400,currency:'USD'});
 assert.deepEqual(result.entities.shoppingContext.relations.map((r:any)=>[r.relation,r.value]),[['recipient','mother'],['intended_use','online classes']]);
 assert.equal(result.entities.catalogPurpose,undefined);
 for(const relation of result.entities.shoppingContext.relations)assert.equal([...text].slice(relation.start,relation.end).join(''),relation.text);
});
test('aliases and multiword vocabulary are read from the compiled pack',()=>{
 const result=resolve(compiled,'Find a laptop for my mum for remote lessons under $500');
 assert.equal(result.status,'RESOLVED');assert.equal(result.entities.price.value,500);
 assert.deepEqual(result.entities.shoppingContext.relations.map((r:any)=>r.value),['mother','online classes']);
 const changed=structuredClone(pack);changed.concepts.find(c=>c.id==='activity.online-classes')!.aliases.push('distance learning');
 const next=resolve(compile({...buildKnowledge(),languageKnowledge:changed}),'find laptop for distance learning');
 assert.equal(next.entities.shoppingContext.relations[0].value,'online classes');
});
test('published audience, country, occasion and color relations attach to the product read',()=>{
 for(const [text,expected] of [
  ['find blue shoes for women',[['color','blue'],['audience','women']]],
  ["find women's shoes in orange",[['audience','women'],['color','orange']]],
  ['find shoes made in Egypt for my mother',[['origin_country','Egypt'],['recipient','mother']]],
  ['find laptop for Egypt',[['market_country','Egypt']]],
  ['find shoes shipping to Egypt',[['destination_country','Egypt']]],
  ['find necklace for a birthday for my mother',[['occasion','birthday'],['recipient','mother']]],
 ] as const){
  const result=resolve(compiled,text);assert.equal(result.status,'RESOLVED',text);
  assert.deepEqual(result.entities.shoppingContext.relations.map((r:any)=>[r.relation,r.value]),expected,text);
 }
 assert.equal(resolve(compiled,'find shoes in orange').entities.color,'orange');
});
test('negated intended use stays explicit without excluding all capable products',()=>{
 const result=resolve(compiled,'find laptop not for gaming under $800');
 assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'PRODUCT_SEARCH');
 assert.equal(result.entities.productText,'laptop');assert.equal(result.entities.price.value,800);
 assert.equal(result.entities.shoppingContext.relations[0].negated,true);
 assert.equal(result.entities.shoppingContext.relations[0].relation,'intended_use');
 assert.equal(result.entities.requestConstraints,undefined);
});
test('partial matches and conflicting color meanings require clarification',()=>{
 for(const text of ["find charger for my mother's iPhone",'find laptop for online classes and office work','find shoes in blue in red','find laptop for us']){
  const result=resolve(compiled,text);
  assert.equal(result.status,'NEEDS_CONTEXT',text);
  assert.ok(result.entities.shoppingContext.unresolved.length,text);
  assert.equal(result.entities.catalogPurpose,undefined,text);
 }
 const country=resolve(compiled,'find laptop for US');assert.equal(country.entities.shoppingContext.relations[0].value,'United States');
});
test('unknown uses are retained as unresolved requirements with a focused question',()=>{
 const text='find laptop for orbital simulation under $800';
 const result=resolve(compiled,text);
 assert.equal(result.status,'NEEDS_CONTEXT');assert.equal(result.entities.productText,'laptop');
 assert.equal(result.entities.shoppingContext.unresolved[0].text,'for orbital simulation');
 assert.match(result.message,/intended use, recipient/);
 assert.deepEqual(result.operations,[]);
});
test('vocabulary alone, product names and other actions do not authorize a search',()=>{
 for(const text of ['blue','women','Egypt','online classes','for mother','add shoes for women to cart','buy laptop for online classes','find "Food for Thought"','find \'For Women\'','find orange juice','find laptop for online classes and checkout','find milk safe for my nut allergy','find charger compatible with my iPhone 13','find milk for my mother without nuts','find laptop for online classes if it is discounted','two for $40','delivery for Friday']){
  assert.equal(contextualShoppingSearch(index,text),undefined,text);
 }
});
test('source evidence is retained through whitespace and longest aliases',()=>{
 const text='  Find navy blue shoes for my mother   ';
 const result=resolve(compiled,text);assert.equal(result.status,'RESOLVED');
 assert.equal(result.entities.color,'blue');
 for(const relation of result.entities.shoppingContext.relations)assert.equal([...text].slice(relation.start,relation.end).join(''),relation.text);
 assert.equal(result.entities.shoppingContext.relations[0].text,'navy blue');
});

test('all published canonical concepts remain reachable in explicit relationship grammar',()=>{
 const published=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-v1.json',import.meta.url),'utf8')) as LanguageKnowledgePack;
 const engine=compile({...buildKnowledge(),languageKnowledge:published});
 for(const concept of published.concepts){
  const marker=concept.kind==='country'?'made in':concept.kind==='color'?'in':'for';
  const tail=concept.kind==='person'?'for online classes':'for my mother';
  const text=`find shoes ${marker} ${concept.canonical} ${tail}`;
  const result=resolve(engine,text);
  assert.equal(result.status,'RESOLVED',concept.id+': '+text);
  if(concept.kind==='device')assert.ok(result.entities.evidenceRequirements?.some((row:any)=>row.kind===(concept.metadata?.requiresExactModel?'device_compatibility':'named_device_compatibility')&&row.text.includes(concept.canonical)),concept.id+': '+text);
  else assert.ok(result.entities.shoppingContext?.relations.some((relation:any)=>relation.conceptId===concept.id),concept.id+': '+text);
  for(const relation of result.entities.shoppingContext.relations)assert.equal([...text].slice(relation.start,relation.end).join(''),relation.text);
 }
});

test('search enrichment cannot replace established write, event, or domain-read routes',()=>{
 const published=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-v1.json',import.meta.url),'utf8')) as LanguageKnowledgePack;
 const engine=compile({...buildExpandedDictionary(),languageKnowledge:published});
 for(const [text,intent] of [
  ['Is the price lower for a large quantity?','BULK_DISCOUNT'],
  ['The parcel contained something different from what I bought','ORDER_WRONG_ITEM'],
  ['include two quasar widgets in my cart','ADD_TO_CART'],
  ['take out two rugs from my basket','REMOVE_FROM_CART'],
  ['show ready for pickup please','PICKUP_READY'],
  ['searching for oranges','PRODUCT_SEARCH'],['shopping for oranges','PRODUCT_SEARCH'],['help me look for oranges','PRODUCT_SEARCH'],
 ]){
  const after=resolve(engine,text);
  assert.equal(after.intent,intent,text);assert.equal(after.status,'RESOLVED',text);
  assert.equal(after.entities.shoppingContext,undefined,text);
 }
});
