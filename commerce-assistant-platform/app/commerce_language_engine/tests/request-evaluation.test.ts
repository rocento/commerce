import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareRequest,requestMetrics,type RequestMeaning} from '../src/evaluation/requests.ts';

const expected:RequestMeaning = {
  status:'RESOLVED',intent:null,entities:{items:[{productText:'apples',quantity:2},{productText:'milk'}]},
  requestedActions:[{id:'request1',intent:'ADD_TO_CART',items:[{productText:'apples',quantity:2}],after:null},
    {id:'request2',intent:'ADD_TO_WISHLIST',items:[{productText:'milk'}],after:'request1'}],
  operations:['ADD_ITEM','SAVE_TO_WISHLIST'],references:[],issues:[],
};

test('same intent and high confidence cannot hide lost products, quantities or actions',()=>{
 for(const changed of [
   {...expected,entities:{items:[{productText:'apples',quantity:1},{productText:'milk'}]}},
   {...expected,requestedActions:expected.requestedActions.slice(0,1)},
   {...expected,requestedActions:[...expected.requestedActions].reverse()},
   {...expected,operations:['ADD_ITEM']},
   {...expected,references:[{expression:'there',kind:'address',resolved:false}]},
 ]){
   const score=compareRequest(changed as RequestMeaning,expected);
   assert.equal(score.passed,false);
   const metrics=requestMetrics([{id:'wrong',family:'compound',status:'RESOLVED',expectedStatus:'RESOLVED',confidence:1,...score}]);
   assert.equal(metrics.incorrectResolved,1);
   assert.equal(metrics.resolvedWholeRequestReliability.brierScore,1);
 }
});

test('full entities detect extra writes, removed constraints and changed money direction',()=>{
 const search:RequestMeaning={...expected,intent:'PRODUCT_SEARCH',entities:{price:{operator:'<',value:50,currency:'USD'},requestConstraints:[{kind:'EXCLUSION',value:'Nike'}]},requestedActions:[],operations:[]};
 for(const entities of [{price:{operator:'<=',value:50,currency:'USD'}}, {price:{operator:'<',value:50,currency:'EUR'}}, {}]){
  assert.deepEqual(compareRequest({...search,entities},search).errors,['entities']);
 }
 assert.equal(compareRequest({...search,operations:['ADD_ITEM']},search).passed,false);
});

test('incomplete annotations and empty corpora are rejected',()=>{
 const partial={...expected} as Partial<RequestMeaning>;delete partial.entities;
 assert.throws(()=>compareRequest(expected,partial as RequestMeaning),/all semantic dimensions/);
 assert.throws(()=>requestMetrics([]),/empty/);
});

test('safe abstention is separated from a wrong resolved result',()=>{
 const rows=[{id:'1',family:'negative',status:'NEEDS_CONTEXT',expectedStatus:'NEEDS_CONTEXT',confidence:0,...compareRequest({...expected,status:'NEEDS_CONTEXT'},{...expected,status:'NEEDS_CONTEXT'})}];
 assert.equal(requestMetrics(rows).fullRequestExactMatch,1);
 assert.equal(requestMetrics(rows).abstained,1);
 assert.equal(requestMetrics(rows).resolvedWholeRequestReliability.count,0);
});
