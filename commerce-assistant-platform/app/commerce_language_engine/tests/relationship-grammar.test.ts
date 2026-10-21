import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileKnowledge,type LanguageKnowledgePack} from '../src/language-knowledge.ts';
import {contextualShoppingSearch} from '../src/contextual-language.ts';
import {compile} from '../src/compiler.ts';
import {buildKnowledge} from '../src/knowledge.ts';
import {resolve} from '../src/engine.ts';

const pack:LanguageKnowledgePack={schemaVersion:1,id:'grammar-heldout',revision:1,language:'en',source:'Held-out grammar combinations, independent of the CSV examples',concepts:[
 {id:'person.mother',kind:'person',canonical:'mother',aliases:['mom'],metadata:{personRole:'recipient'}},
 {id:'person.sister',kind:'person',canonical:'sister',aliases:[],metadata:{personRole:'recipient'}},
 {id:'activity.online_classes',kind:'activity',canonical:'online classes',aliases:['remote lessons']},
 {id:'activity.gaming',kind:'activity',canonical:'gaming',aliases:[]},
 {id:'occasion.birthday',kind:'occasion',canonical:'birthday',aliases:[]},
 {id:'device.iphone_13',kind:'device',canonical:'iPhone 13',aliases:[]},
],rules:[
 {id:'for.recipient',marker:'for',targetKind:'person',relation:'recipient',scope:'product',priority:100,targetMetadata:{personRole:'recipient'}},
 {id:'for.activity',marker:'for',targetKind:'activity',relation:'intended_use',scope:'product',priority:100},
 {id:'for.occasion',marker:'for',targetKind:'occasion',relation:'occasion',scope:'product',priority:100},
 {id:'for.device',marker:'for',targetKind:'device',relation:'compatibility_target',scope:'product',priority:100},
 {id:'use.relative',marker:'who mainly uses it for',targetKind:'activity',relation:'intended_use',scope:'product',priority:120},
 {id:'use.purpose',marker:'to use for',targetKind:'activity',relation:'intended_use',scope:'product',priority:120},
 {id:'gift.recipient',marker:'as a gift for',targetKind:'person',relation:'recipient',scope:'product',priority:120,targetMetadata:{personRole:'recipient'}},
 {id:'works.device',marker:'that works with',targetKind:'device',relation:'compatibility_target',scope:'product',priority:120},
]};
const index=compileKnowledge(pack);
const rows=(text:string)=>{
 const result=contextualShoppingSearch(index,text);assert.ok(result,text);
 for(const row of [...result.relations,...result.unresolved??[]])assert.equal([...text].slice(row.start,row.end).join(''),row.text,text);
 return result;
};

test('a shared for marker resolves each coordinated noun by its published semantic kind',()=>{
 for(const [text,expected] of [
  ['Find a laptop for my mother and gaming',[['recipient','mother','for my mother'],['intended_use','gaming','and gaming']]],
  ['Find a laptop for my mother and my sister',[['recipient','mother','for my mother'],['recipient','sister','and my sister']]],
  ['Find a laptop for my mother and for remote lessons',[['recipient','mother','for my mother'],['intended_use','online classes','and for remote lessons']]],
  ['Find a laptop for gaming and my sister for her birthday',[['intended_use','gaming','for gaming'],['recipient','sister','and my sister'],['occasion','birthday','for her birthday']]],
 ] as const){
  const result=rows(text);assert.equal(result.unresolved,undefined,text);
  assert.deepEqual(result.relations.map(row=>[row.relation,row.value,row.text]),expected,text);
  assert.equal(result.productText,'laptop');
 }
});

test('explicit coordinated negation stays local and implicit ambiguous negation is retained',()=>{
 const positive=rows('Find a laptop for online classes and not for gaming');
 assert.deepEqual(positive.relations.map(row=>[row.value,row.negated,row.text]),[['online classes',false,'for online classes'],['gaming',true,'and not for gaming']]);
 assert.equal(positive.unresolved,undefined);
 const reversal=rows('Find a laptop not for gaming and for remote lessons');
 assert.deepEqual(reversal.relations.map(row=>[row.value,row.negated]),[['gaming',true],['online classes',false]]);
 for(const text of ['Find a laptop not for gaming and remote lessons','Find a laptop for gaming and not remote lessons']){
  const result=rows(text);assert.ok(result.unresolved?.length,text);
  assert.equal(result.relations.length,1,text);
  assert.match(result.unresolved![0].text,/^and (?:not )?remote lessons$/);
 }
});

test('possessive people qualify occasions and compatibility without becoming inferred recipients',()=>{
 for(const text of ["Find a necklace for my mother's birthday",'Find a necklace for my mom’s birthday']){
  const result=rows(text);assert.equal(result.unresolved,undefined);
  assert.deepEqual(result.relations.map(row=>[row.relation,row.value]),[['occasion','birthday']]);
  assert.equal(result.relations[0].text,text.slice(text.indexOf('for ')));
 }
 const device=rows("Find a charger for my sister's iPhone 13");
 assert.deepEqual(device.relations.map(row=>[row.relation,row.value]),[['compatibility_target','iPhone 13']]);
 assert.equal(device.unresolved,undefined);
 for(const text of ["Find a necklace for my neighbor's birthday", "Find a necklace for my mother's surprise birthday", "Find a charger for my sister's iPhone 13 mystery edition"]){
  const result=rows(text);assert.ok(result.unresolved?.length,text);assert.deepEqual(result.relations,[],text);
 }
});

test('published relative clauses require a positive person antecedent and retain source spans',()=>{
 const text='I am buying a phone for my mother, who mainly uses it for remote lessons under $400.';
 const result=rows(text);assert.equal(result.productText,'phone');assert.equal(result.coreText,'find phone under $400');
 assert.equal(result.unresolved,undefined);
 assert.deepEqual(result.relations.map(row=>[row.relation,row.value,row.text]),[['recipient','mother','for my mother'],['intended_use','online classes','who mainly uses it for remote lessons']]);
 for(const text of ['Find a laptop who mainly uses it for gaming','Find a laptop for gaming who mainly uses it for remote lessons','Find a laptop not for my mother who mainly uses it for gaming']){
  const result=rows(text);assert.ok(result.unresolved?.length,text);assert.equal(result.unresolved![0].reason,'ambiguous_meaning',text);
 }
});

test('relationship markers and aliases can be extended only by publishing data',()=>{
 const changed=structuredClone(pack);
 changed.rules.push({id:'purpose.heldout',marker:'for the purpose of',targetKind:'activity',relation:'intended_use',scope:'product',priority:130});
 changed.concepts.find(row=>row.id==='activity.gaming')!.aliases.push('competitive play');
 const text='Find a laptop for the purpose of competitive play';
 const before=contextualShoppingSearch(index,text);assert.ok(before?.unresolved?.length);
 const after=contextualShoppingSearch(compileKnowledge(changed),text);assert.equal(after?.unresolved,undefined);
 assert.equal(after?.relations[0].value,'gaming');assert.equal(after?.relations[0].ruleId,'purpose.heldout');
 for(const [text,relation] of [['Find a laptop to use for remote lessons','intended_use'],['Find a phone as a gift for my sister','recipient'],['Find a charger that works with my iPhone 13','compatibility_target']]){
  assert.equal(rows(text).relations[0].relation,relation,text);
 }
});

test('unknown coordinated tails, extra actions, and operators cannot disappear',()=>{
 for(const text of ['Find a laptop for gaming and orbital simulation','Find a phone for my mother and her unusual request']){
  const result=rows(text);assert.ok(result.unresolved?.length,text);assert.match(result.unresolved![0].text,/^and /);
 }
 for(const text of ['Buy a laptop for gaming','I am buying a phone for my mother and checkout','Find a charger that works with my iPhone 13 and add it to my cart','Find a laptop for online $ classes','Find a laptop for gaming $','Find a laptop for my mother + gaming','Find a laptop for 通話 gaming','Find a laptop for online 通話 classes']){
  assert.equal(contextualShoppingSearch(index,text),undefined,text);
 }
});


test('descriptive buying remains a read while imperative buying retains its established route',()=>{
 const engine=compile({...buildKnowledge(),languageKnowledge:pack});
 for(const head of ['I am buying',"I'm buying",'I’m buying','We are buying',"We're buying"]){
  const text=head+' a phone for my mother, who mainly uses it for remote lessons under $400';
  const result=resolve(engine,text);assert.equal(result.status,'RESOLVED',text);assert.equal(result.intent,'PRODUCT_SEARCH',text);
  assert.equal(result.entities.productText,'phone',text);assert.equal(result.entities.price.value,400,text);
  assert.deepEqual(result.entities.shoppingContext.relations.map((row:any)=>[row.relation,row.value]),[['recipient','mother'],['intended_use','online classes']],text);
  for(const row of result.entities.shoppingContext.relations)assert.equal([...text].slice(row.start,row.end).join(''),row.text,text);
 }
 assert.equal(contextualShoppingSearch(index,'Buy a phone for my mother'),undefined);
});
