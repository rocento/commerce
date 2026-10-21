import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';
import {validContext} from '../src/context.ts';

const runtime=compile(buildExpandedDictionary());

test('unscoped colliding catalog terms return explicit ambiguity candidates',()=>{
 const result=resolve(runtime,'find apple');
 assert.equal(result.status,'AMBIGUOUS');assert.equal(result.intent,null);
 assert.deepEqual(result.ambiguities?.[0]?.candidates.map(candidate=>candidate.kind+':'+candidate.value),['BRAND:Apple','CATEGORY:apple']);
 assert.match(result.message,/brand Apple or category apple/);
});

test('database decimal weights remain numeric after artifact compilation',()=>{
 const dictionary=structuredClone(runtime.dictionary);
 for(const ambiguity of dictionary.semanticModel!.ambiguities)ambiguity.priorWeight=String(ambiguity.priorWeight) as unknown as number;
 const result=resolve(compile(dictionary),'find apple');
 assert.equal(result.status,'AMBIGUOUS');assert.ok(result.ambiguities?.[0]?.candidates.every(candidate=>Number.isFinite(candidate.score)));
});

test('store industry context resolves catalog collisions without inventing ownership',()=>{
 const grocery=resolve(runtime,'find apple',{industry:'GROCERY'});
 assert.equal(grocery.status,'RESOLVED');assert.equal(grocery.ambiguities?.[0]?.clarificationRequired,false);
 assert.equal(grocery.ambiguities?.[0]?.candidates[0]?.industry,'GROCERY');
 const electronics=resolve(runtime,'find silver phone');
 assert.equal(electronics.ambiguities?.[0]?.clarificationRequired,false);
 assert.equal(electronics.ambiguities?.[0]?.candidates[0]?.industry,'ELECTRONICS');
});

test('singular and plural pronouns bind only compatible prior items',()=>{
 const missing=resolve(runtime,'add it to cart');assert.equal(missing.status,'NEEDS_CONTEXT');assert.equal(missing.references?.[0]?.state,'REFERENCE_PENDING');
 const singular=resolve(runtime,'add it to cart',{selectedItems:[{productText:'mug'}]});assert.equal(singular.status,'RESOLVED');assert.equal(singular.entities.items[0]?.productText,'mug');
 const plural=resolve(runtime,'add them to cart',{selectedItems:[{productText:'mug'},{productText:'plate'}]});assert.equal(plural.status,'RESOLVED');assert.deepEqual(plural.entities.items.map((item:any)=>item.productText),['mug','plate']);
 const ambiguous=resolve(runtime,'add that to cart',{selectedItems:[{productText:'mug'},{productText:'plate'}]});assert.equal(ambiguous.status,'AMBIGUOUS');assert.equal(ambiguous.ambiguities?.[0]?.candidates.length,2);
});

test('location references require conversation context and never infer an address',()=>{
 const unresolved=resolve(runtime,'create an order for two apples and deliver it there');assert.equal(unresolved.status,'NEEDS_CONTEXT');assert.equal(unresolved.entities.delivery?.addressReference,undefined);
 const resolved=resolve(runtime,'create an order for two apples and deliver it there',{deliveryAddressReference:'HOME'});assert.equal(resolved.entities.delivery?.addressReference,'HOME');assert.equal(resolved.references?.find((reference:any)=>reference.kind==='address')?.state,'RESOLVED');
});

test('result-set ranking references remain symbolic until a commerce lookup',()=>{
 const pending=resolve(runtime,'add the cheapest one to cart');assert.equal(pending.status,'NEEDS_CONTEXT');assert.equal(pending.references?.[0]?.state,'REFERENCE_PENDING');
 const ranked=resolve(runtime,'add the cheapest one to cart',{resultSetItems:[{productText:'apples'},{productText:'milk'}]});assert.equal(ranked.status,'RESOLVED');assert.equal(ranked.references?.[0]?.state,'AUTHORITY_LOOKUP_REQUIRED');assert.equal(ranked.slots?.find((slot:any)=>slot.code==='PRODUCT_TEXT')?.state,'AUTHORITY_LOOKUP_REQUIRED');assert.equal(ranked.entities.items[0]?.productText,undefined);
});

test('explicit last-order lookup stays symbolic and does not claim an owned order',()=>{
 const last=resolve(runtime,'repeat my last order');assert.equal(last.status,'RESOLVED');assert.equal(last.entities.order?.resolvedReference,undefined);assert.equal(last.references?.[0]?.state,'AUTHORITY_LOOKUP_REQUIRED');
 const unresolved=resolve(runtime,'do it again');assert.equal(unresolved.status,'NEEDS_CONTEXT');
 const selected=resolve(runtime,'do it again',{previousIntent:'ORDER_DETAILS',states:['ORDER_SELECTED']});assert.equal(selected.status,'RESOLVED');assert.equal(selected.entities.order?.resolvedReference,undefined);assert.equal(selected.references?.[0]?.state,'AUTHORITY_LOOKUP_REQUIRED');
});

test('context bounds result sets and store industry values',()=>{
 assert.equal(validContext({industry:'GROCERY',resultSetItems:[{productText:'apples'}]},runtime.dictionary),true);
 assert.equal(validContext({industry:'NOT_A_STORE'},runtime.dictionary),false);
 assert.equal(validContext({resultSetItems:[{productText:'apples',productId:'forged'}]},runtime.dictionary),false);
 assert.equal(validContext({resultSetItems:Array.from({length:51},()=>({productText:'apples'}))},runtime.dictionary),false);
});
