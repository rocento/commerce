import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adjudicateCase} from '../src/generation/corpus-adjudication.ts';
import {caseKey} from '../src/generation/corpus.ts';
import type {CorpusCase} from '../src/types.ts';

const make=(text:string,extra:Partial<CorpusCase>={}):CorpusCase=>({text,intent:'ADD_TO_CART',status:'RESOLVED',difficulty:'MEDIUM',...extra});

test('adjudication preserves entity assertions and identity while repairing all generic-product siblings',()=>{
 for(const [source,text] of [['compositional-structure-v4','please add any two fresh items in cart'],['compositional-structure-v4','take any two fresh items out of my favorites']] as const){
  const input=make(text,{source,split:'test',templateFamily:'request-structure-test',entities:{quantity:2,selection:'ANY_MATCHING',freshness:'fresh'}});
  const untouched=structuredClone(input),{next}=adjudicateCase(input);
  assert.deepEqual(input,untouched);assert.deepEqual(next.entities,input.entities);assert.equal(next.status,'NEEDS_CONTEXT');assert.equal(next.text,input.text);assert.equal(next.split,input.split);
  assert.deepEqual(adjudicateCase(next).next,next);
 }
 const explicit=make('add any two organic apples to cart',{source:'compositional-structure-v4'});
 assert.deepEqual(adjudicateCase(explicit).next,explicit);
});

test('industry provenance restores scope without inventing products or applying to context-free user cases',()=>{
 const scoped=make('find apple',{intent:'PRODUCT_SEARCH',source:'industry-coverage-v7',templateFamily:'industry-search-GROCERY-test'});
 const corrected=adjudicateCase(scoped).next;
 assert.deepEqual(corrected.context,{industry:'GROCERY'});
 const contextualFree=make('find apple',{intent:null,status:'AMBIGUOUS'});
 assert.deepEqual(adjudicateCase(contextualFree).next,contextualFree);
 assert.notEqual(caseKey(corrected),caseKey({...corrected,context:{industry:'ELECTRONICS'}}));
});

test('a list does not supply a selected write target, and explicit product nouns cannot select orders',()=>{
 const list=make('please add',{source:'transition-v2',context:{previousIntent:'PRODUCT_SEARCH',states:['PRODUCT_RESULTS_VISIBLE']}});
 assert.equal(adjudicateCase(list).next.status,'NEEDS_CONTEXT');
 const selected={...list,context:{previousIntent:'SELECT_PRODUCT',states:['PRODUCT_SELECTED']}};
 assert.equal(adjudicateCase(selected).next.status,'RESOLVED');
 const order=make('second product',{source:'transition-v2',intent:'SELECT_ORDER',context:{previousIntent:'ORDER_HISTORY',states:['ORDER_LIST_VISIBLE']}});
 assert.equal(adjudicateCase(order).next.intent,null);
 assert.equal(adjudicateCase(order).next.status,'UNKNOWN');
 const repeat=make('same again',{source:'transition-v2',intent:'REORDER',context:order.context});
 assert.equal(adjudicateCase(repeat).next.status,'NEEDS_CONTEXT');
});

test('semantic distinctions remain narrow across negation, explicit cancellation and count nouns',()=>{
 const pretend=make('pretend to add my cart',{source:'contrastive-coverage-v6',templateFamily:'metalinguistic-command-2',intent:null,status:'UNKNOWN'});
 assert.equal(adjudicateCase(pretend).next.intent,'CONVERSATION_JOKE');
 for(const text of ['translate add my cart','do not add my cart']){
  const negative={...pretend,text,templateFamily:'metalinguistic-command-0'};
  assert.deepEqual(adjudicateCase(negative).next,negative);
 }
 const cancel=make('cancel duplicate order',{source:'intent-command-v2',intent:'ORDER_DUPLICATE'});
 assert.equal(adjudicateCase(cancel).next.intent,'CANCEL_ORDER');
 const report={...cancel,text:'report duplicate order'};
 assert.deepEqual(adjudicateCase(report).next,report);
 const count=make('show cart item count',{source:'syntax-composition-v6',intent:'CART_ITEM_COUNT'});
 assert.equal(adjudicateCase(count).next.intent,'CART_TOTAL');
 const money={...count,text:'show cart total',intent:'CART_TOTAL'};
 assert.deepEqual(adjudicateCase(money).next,money);
 const offers=make('show offers',{source:'intent-command-v2',intent:'CHECK_PROMOTION'});
 assert.equal(adjudicateCase(offers).next.intent,'PRODUCT_RECOMMEND');
 assert.deepEqual(adjudicateCase(offers).next.entities,{discountRanking:true});
 const code={...offers,text:'show promo code'};
 assert.deepEqual(adjudicateCase(code).next,code);
});

test('question-grammar names preserve their literal case without relaxing exact assertions elsewhere',()=>{
 const input=make('do you sell Local Bananas 1kg',{source:'product-search-requests-v2',templateFamily:'conversational-search',intent:'PRODUCT_SEARCH',entities:{productText:'local bananas 1kg'}});
 assert.deepEqual(adjudicateCase(input).next.entities,{productText:'Local Bananas 1kg'});
 const budget={...input,text:input.text+' under $50',entities:{...input.entities,price:{operator:'<',value:50,currency:'USD'}}};
 assert.deepEqual(adjudicateCase(budget).next,budget);
 const otherHead={...input,text:'find Local Bananas 1kg'};
 assert.deepEqual(adjudicateCase(otherHead).next,otherHead);
});
