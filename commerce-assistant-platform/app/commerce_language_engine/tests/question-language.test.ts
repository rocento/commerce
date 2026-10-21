import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {parseLanguageKnowledge} from '../src/language-knowledge.ts';
import {questionRead,questionLeadIn} from '../src/question-language.ts';
const dictionary=(recognitionFixture(JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const pack=JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-v1.json',import.meta.url),'utf8'));
const engine=compile({...dictionary,languageKnowledge:pack});

test('question templates compose with reviewed lead-ins and sentence wrappers',()=>{
 for(const prefix of ['', 'Hi, ', 'Quick question: ', 'Before I decide, ', 'I am comparing options. ']){
  for(const [question,intent] of [['How much is Acme Notebook right now?','CHECK_PRICE'],['What should I know before buying Acme Notebook?','PRODUCT_DETAILS'],['Is Acme Notebook available?','CHECK_STOCK']] as const){
   const result=resolve(engine,prefix+question);
   assert.equal(result.status,'RESOLVED',prefix+question);assert.equal(result.intent,intent);
   assert.equal(result.entities.productText,'Acme Notebook');assert.deepEqual(result.operations,[]);
  }
 }
});
test('quantity-price questions retain quantity and literal product, not delivery intent',()=>{
 const result=resolve(engine,'What would 3 of Acme Notebook cost before delivery?');
 assert.equal(result.intent,'CHECK_PRICE');assert.equal(result.entities.quantity,3);assert.equal(result.entities.productText,'Acme Notebook');
 assert.deepEqual(result.operations,[]);assert.equal(result.requiresConfirmation,false);
});
test('save-for-later purpose clauses retain the explicit wishlist command and named product',()=>{
 for(const prefix of ['', 'Hi, ', 'Quick question: ', 'I am comparing options. ']){
  const result=resolve(engine,prefix+'Save Acme Notebook so I can think about it later.');
  assert.equal(result.status,'RESOLVED');assert.equal(result.intent,'ADD_TO_WISHLIST');
  assert.equal(result.entities.productText.toLowerCase(),'acme notebook');
 }
 const extra=resolve(engine,'Save Acme Notebook so I can think about it later and buy milk.');
 assert.notEqual(extra.status==='RESOLVED'&&extra.intent==='ADD_TO_WISHLIST'&&!extra.requestType,true);
});
test('comparisons preserve both named products and policy questions stay reads',()=>{
 const result=resolve(engine,'How does Acme Notebook compare with Atlas Tablet?');
 assert.equal(result.intent,'PRODUCT_COMPARE');assert.deepEqual(result.entities.items,[{productText:'Acme Notebook'},{productText:'Atlas Tablet'}]);
 const policy=resolve(engine,'Can I return Acme Notebook if it is not right for me?');
 assert.equal(policy.intent,'RETURN_POLICY');assert.deepEqual(policy.operations,[]);
});
test('compatibility questions preserve both targets and ask for specifications rather than guessing',()=>{
 for(const text of ['Will wireless earbuds work with an iPhone 13?','Will wireless earbuds work with a Samsung Galaxy S23? I do not want to buy something incompatible.']){
  const result=resolve(engine,text);
  assert.equal(result.intent,'PRODUCT_COMPATIBILITY');assert.equal(result.status,'NEEDS_CONTEXT');
  assert.equal(result.entities.productText,'wireless earbuds');assert.ok(result.entities.deviceText);
  const evidence=result.entities.evidenceRequirements[0];assert.equal([...text].slice(evidence.start,evidence.end).join(''),evidence.text);
  assert.match(result.message,/specifications/);assert.deepEqual(result.operations,[]);
 }
 assert.equal(questionRead(pack,'Will earbuds work with my mother?'),undefined);
});
test('unpublished question templates can be added through data without changing parser code',()=>{
 const expanded=structuredClone(pack);
 expanded.questionRules.push({id:'question.heldout',intent:'CHECK_PRICE',templates:['what is the asking price for {product}']});
 const parsed=parseLanguageKnowledge(expanded);
 assert.equal(questionRead(parsed,'What is the asking price for Atlas Tablet?')?.entities.productText,'Atlas Tablet');
 assert.equal(questionRead(pack,'What is the asking price for Atlas Tablet?'),undefined);
});
test('templates cannot authorize writes, silently trim conditions, or choose conflicting meanings',()=>{
 for(const question of ['What would 0 of Acme Notebook cost before delivery?','What would -3 of Acme Notebook cost before delivery?','Tell me about Acme Notebook and cancel my order.','Tell me about Acme Notebook if it is safe for my allergy.','Show me the details of Acme Notebook. Buy it.'])assert.equal(questionRead(pack,question),undefined,question);
 const unsafe=structuredClone(pack);unsafe.questionRules[0].intent='ADD_TO_CART';assert.throws(()=>parseLanguageKnowledge(unsafe));
 const ambiguous=structuredClone(pack);ambiguous.questionRules.push({id:'conflicting',intent:'CHECK_STOCK',templates:['tell me about {product}']});assert.throws(()=>parseLanguageKnowledge(ambiguous));
 const badSlot=structuredClone(pack);badSlot.questionRules[0].templates=['find {product}{other}'];assert.throws(()=>parseLanguageKnowledge(badSlot));
 for(const action of ['transfer my wishlist to my cart','order bread','put bread in my cart','empty my cart'])assert.equal(questionRead(pack,'Tell me about milk and '+action),undefined);
 assert.equal(questionLeadIn(pack,'Hi $100, show milk'),undefined);
 assert.equal(questionLeadIn(pack,'Hi 🚫, show milk'),undefined);
});

test('polite or comma-separated writes cannot hide inside a question product slot',()=>{
 for(const text of [
  'Tell me about milk and please save bread to my wishlist',
  'Tell me about milk, save bread to my wishlist',
  'Tell me about milk and kindly exchange my shoes',
  'Do you sell milk and also compare bread with cheese',
 ])assert.equal(questionRead(pack,text),undefined,text);
 for(const text of ['Tell me about milk and please save bread to my wishlist','Tell me about milk, save bread to my wishlist']){
  const result=resolve(engine,text);
  assert.notEqual(result.status==='RESOLVED'&&result.intent==='PRODUCT_DETAILS'&&!result.requestType,true,text);
 }
});

test('complete question templates defer conditional and monetary qualifiers to constraint handling',()=>{
 for(const text of [
  'Tell me about laptop as long as it costs at most $50',
  'Tell me about laptop provided that it is waterproof',
  'Tell me about laptop only when shipping is free',
  'Tell me about laptop at most $50',
 ])assert.equal(questionRead(pack,text),undefined,text);
 const result=resolve(engine,'Tell me about laptop as long as it costs at most $50');
 assert.equal(result.status,'NEEDS_CONTEXT');
 assert.ok(result.entities.requestConstraints?.some((row:any)=>row.kind==='CONDITION'));
});

test('alias matching never erases an unknown word while literal merchant names keep Unicode',()=>{
 for(const prefix of ['Hi 通話','Hi通話','Quick вопрос question'])assert.equal(questionLeadIn(pack,prefix+', tell me about milk'),undefined,prefix);
 for(const device of ['my 通話 iPhone 13','my iPhone通話 13'])assert.equal(questionRead(pack,'Will earbuds work with '+device+'?'),undefined,device);
 for(const product of ['Crème Hydratante','東京 Notebook','Café Mélange']){
  assert.equal(questionRead(pack,'Tell me about '+product)?.entities.productText,product);
 }
});

test('wrapped compatibility evidence is indexed against its explicit interpretation source',()=>{
 for(const text of ['Quick question, will earbuds work with my iPhone 13?','I am short on time. Will earbuds work with my iPhone 13? Keep it short.']){
  const result=resolve(engine,text);assert.equal(result.status,'NEEDS_CONTEXT');assert.equal(result.intent,'PRODUCT_COMPATIBILITY');
  const source=result.interpretationText??text;assert.ok(result.interpretationText,text);
  for(const span of result.entities.evidenceRequirements)assert.equal([...source].slice(span.start,span.end).join(''),span.text,text);
  assert.equal(result.entities.deviceText,'my iPhone 13');assert.equal(result.entities.productText,'earbuds');
 }
});

test('question releases require literal words and cap aggregate compiled templates',()=>{
 for(const template of ['{product} ',' {product}','{product}...']){
  const candidate=structuredClone(pack);candidate.questionRules=[{id:'bad.literal',intent:'PRODUCT_DETAILS',templates:[template]}];
  assert.throws(()=>parseLanguageKnowledge(candidate),/question slots/,template);
 }
 const alpha=(value:number)=>{let result='';do{result=String.fromCharCode(97+value%26)+result;value=Math.floor(value/26)-1;}while(value>=0);return result;};
 const candidate=structuredClone(pack);
 candidate.questionRules=Array.from({length:50},(_,group)=>({id:'bounded.'+group,intent:'PRODUCT_DETAILS',templates:Array.from({length:100},(_,i)=>'tell me '+alpha(group*100+i)+' about {product}')}));
 assert.equal(parseLanguageKnowledge(candidate).questionRules!.length,50);
 candidate.questionRules.push({id:'bounded.excess',intent:'PRODUCT_DETAILS',templates:['tell me excess about {product}']});
 assert.throws(()=>parseLanguageKnowledge(candidate),/Too many question templates/);
});

test('a new immutable question release gets its own cached vocabulary and templates',()=>{
 const first=parseLanguageKnowledge(pack);
 assert.equal(questionRead(first,'Tell me about Atlas Tablet')?.entities.productText,'Atlas Tablet');
 const next=structuredClone(first);next.questionRules!.push({id:'cache.new_frame',intent:'PRODUCT_DETAILS',templates:['describe the item {product}']});
 assert.equal(questionRead(parseLanguageKnowledge(next),'Describe the item Atlas Tablet')?.entities.productText,'Atlas Tablet');
 assert.equal(questionRead(first,'Describe the item Atlas Tablet'),undefined);
});

test('question search prompts preserve the literal query through repeated followups and budgets',()=>{
 for(const text of ['Do you sell laptop?','Do you sell laptop? Keep it brief.','Do you sell laptop? What would you recommend?','Hi, do you sell laptop? Keep it brief.']){
  let result=resolve(engine,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.entities.productText,'laptop',text);
  for(const followup of ['What should I look at?','Keep it short.','My budget is $400 now.']){
   result=resolve(engine,followup,result.context.next);
   assert.equal(result.status,'RESOLVED',text+' -> '+followup);assert.equal(result.intent,'PRODUCT_SEARCH');assert.equal(result.entities.productText,'laptop');
   const source=result.interpretationText??followup;
   for(const role of result.entities.shoppingContext?.sentenceRoles??[])assert.equal([...source].slice(role.start,role.end).join(''),role.text);
  }
  assert.deepEqual(result.entities.price,{operator:'<=',value:400,currency:'USD'});
  assert.deepEqual(result.entities.shoppingContext.responsePreferences,['short']);
 }
});

test('every named product question replaces stale product and result-set references',()=>{
 const prior=resolve(engine,'Find shoes under $50').context.next;
 for(const rule of pack.questionRules){
  const template=rule.templates[0];
  const text=template.replace('{product}','Atlas Laptop').replace('{other}','Second Tablet').replace('{device}','my iPhone 13').replace('{quantity}','3');
  const result=resolve(engine,text,{...prior,collection:'wishlist',states:['PRODUCT_SELECTED','PRODUCT_RESULTS_VISIBLE'],selectedItems:[{productText:'Old selected shoes',quantity:8}],resultSetItems:[{productText:'Old result shoes',quantity:9}]});
  assert.equal(result.context.next.resultSetItems,undefined,text);assert.equal(result.context.next.collection,undefined,text);
  assert.ok(!result.context.next.states?.includes('PRODUCT_SELECTED'),text);
  assert.deepEqual(result.context.next.selectedItems,rule.intent==='PRODUCT_COMPARE'?[{productText:'Atlas Laptop'},{productText:'Second Tablet'}]:[{productText:'Atlas Laptop',...(template.includes('{quantity}')?{quantity:3}:{})}],text);
  const add=resolve(engine,'Add it to cart',result.context.next);
  assert.ok(!JSON.stringify(add.entities).includes('Old '),text);
  if(rule.intent==='PRODUCT_COMPARE')assert.notEqual(add.status,'RESOLVED',text);
  else assert.equal(add.entities.items?.[0].productText,'Atlas Laptop',text);
 }
 const quantity=resolve(engine,'What would 3 of Atlas Laptop cost before delivery?',prior);
 assert.deepEqual(quantity.context.next.selectedItems,[{productText:'Atlas Laptop',quantity:3}]);
 assert.equal(resolve(engine,'Add it to cart',quantity.context.next).entities.items[0].quantity,3);
});
