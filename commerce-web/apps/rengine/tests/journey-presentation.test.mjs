import test from 'node:test';
import assert from 'node:assert/strict';
import {describeStep} from '../public/journey-presentation.js';
test('known retrieval and proposal boundaries have distinct meanings; unknown events remain neutral',()=>{
 assert.equal(describeStep({stage:'intent_retrieval'}).type,'retrieval');assert.match(describeStep({stage:'model_proposal'}).description,/not permission/);
 assert.equal(describeStep({stage:'some_rag_named_function',kind:'python',title:'retrieve'}).type,'python');
 assert.equal(describeStep({stage:'unknown',kind:'decision'}).type,'decision');
});

test('timeline cards explain retrieval and incomplete function states without invented success',()=>{
 assert.match(describeStep({stage:'intent_retrieval',evidence:{status:'unavailable'}}).summary,/unavailable/);
 assert.match(describeStep({stage:'intent_retrieval',evidence:{status:'retrieved',examples:[{}]}}).summary,/Found 1 matching example/);
 assert.match(describeStep({stage:'python_function_start',kind:'python',title:'resolve',evidence:{outcome:'running'}}).resultExplanation,/running/);
 assert.match(describeStep({stage:'python_function',kind:'python',title:'resolve',evidence:{outcome:'completion not captured'}}).resultExplanation,/end is missing/);
 assert.equal(describeStep({stage:'language_model_request'}).category,'AI model');
});

test('human statuses distinguish internal completion from request outcomes and evidence-only events',()=>{
 assert.equal(describeStep({stage:'python_function',kind:'python',evidence:{outcome:'returned'}}).stateLabel,'Function finished');
 assert.equal(describeStep({stage:'final_result',evidence:{outcome:'completed'}}).stateLabel,'Request completed');
 assert.equal(describeStep({stage:'final_result',evidence:{}}).stateLabel,'Outcome not captured');
 assert.equal(describeStep({stage:'unknown',evidence:{}}).stateLabel,'Details available');
 assert.equal(describeStep({stage:'language_model_request',evidence:{}}).stateLabel,'AI input prepared');
 assert.equal(describeStep({stage:'intent_retrieval',evidence:{status:'empty'}}).stateLabel,'No examples found');
});


test('routing has a specific purpose and keeps completion separate from action success',()=>{
 const info=describeStep({stage:'python_function',kind:'python',title:'TurnRouting.select',evidence:{outcome:'returned'}});
 assert.equal(info.title,'Choose how to handle the request');
 assert.match(info.description,/shopper’s context/);
 assert.match(info.description,/before any shopping action/);
 assert.match(info.resultExplanation,/does not confirm/);
 assert.match(info.summary,/Selects the execution path/);
});

test('unknown functions do not inherit explanations from similarly named methods',()=>{
 const info=describeStep({stage:'python_function',kind:'python',title:'Other.select',evidence:{outcome:'error'}});
 assert.match(info.description,/not available/);
 assert.match(info.resultExplanation,/stopped with an error/);
 assert.doesNotMatch(info.description,/Selects the execution path/);
});

test('all currently instrumented functions and decision events have specific explanations',()=>{
 const names=['TurnRouting.select','resolve','interpret_resolution','route','ShoppingCatalog.call','ShoppingCatalog.discover',...['discounts','bestsellers','cart','change_cart','transfer_wishlist_to_cart','search_cart_product','wishlist','remove_wishlist_item','add_wishlist_item','product','delivery','locations','support_tickets','support_ticket','call','orders','oldest_order','order_by_number','create_ticket'].map(name=>'CommerceTools.'+name)];
 for(const title of names){const info=describeStep({stage:'python_function',kind:'python',title,evidence:{outcome:'returned'}});assert.doesNotMatch(info.description,/not available for it yet/,title);assert.notEqual(info.title,title);}
 for(const stage of ['execution_route','handler_dispatch','domain_evidence','provider_invalid_response'])assert.doesNotMatch(describeStep({stage}).description,/Inspect the captured evidence for this execution boundary/);
});

test('catalog evidence distinguishes operations, empty results, errors and old reports',()=>{
 const step={stage:'python_function',kind:'python',title:'ShoppingCatalog.call'};
 const search=describeStep({...step,evidence:{outcome:'returned',details:{operation:'search_products',criteria:{query:'fresh fruit'},products_returned:0}}});
 assert.equal(search.title,'Search by text');assert.match(search.summary,/fresh fruit/);assert.match(search.resultExplanation,/0 products/);
 const schema=describeStep({...step,evidence:{outcome:'returned',details:{operation:'get_catalog_schema',schema_returned:true,products_returned:0}}});
 assert.equal(schema.title,'Read catalog structure');assert.doesNotMatch(schema.summary,/0 products/);
 const error=describeStep({...step,evidence:{outcome:'error',details:{operation:'search_products',criteria:{query:'fruit'}}}});
 assert.equal(error.stateLabel,'Function failed');assert.doesNotMatch(error.summary,/products returned/);
 assert.equal(describeStep({...step,evidence:{outcome:'returned'}}).title,'Request catalog information');
});

test('execution alternatives explain the recorded branch without claiming unobserved checks',async()=>{
 const {describeExecutionRoute}=await import('../public/journey-presentation.js');
 for(const [reason,path] of Object.entries({existing_deterministic:'deterministic',provider_unavailable:'deterministic',flag_off:'legacy',journey_disabled:'legacy',core_unavailable:'legacy',core_selected:'core'})){
  const info=describeExecutionRoute({reason,path});assert.equal(info.options.filter(x=>x.selected).length,1);assert.equal(info.options.length,3);assert.ok(info.options.every(x=>x.explanation));
 }
 assert.match(describeExecutionRoute({path:'deterministic',reason:'existing_deterministic'}).options.find(x=>x.path==='core').explanation,/does not establish/);
 assert.match(describeExecutionRoute({path:'legacy',reason:'unknown'}).reason,/does not include/);
});

test('catalog searches distinguish text, filters and local filtering without guessing',()=>{
 const describe=criteria=>describeStep({stage:'python_function',kind:'python',title:'ShoppingCatalog.call',evidence:{outcome:'returned',details:{operation:'search_products',criteria,products_returned:0}}});
 assert.equal(describe({query:'fruit',attributes:[],in_stock:false,currency:'EGP'}).title,'Search by text');
 for(const criteria of [{query:'*',max_price:'200'},{query:'fruit',category_id:'fruit'},{query:'fruit',min_price:0},{query:'*',in_stock:true},{query:'*',predicates:[{name:'fresh',value:true}]}])assert.equal(describe(criteria).title,'Search with filters');
 assert.equal(describe({query:'*'}).title,'Browse catalog');
 const local=describeStep({stage:'catalog_filter',evidence:{products_before:8,products_after:3,checks:['Category membership']}});
 assert.equal(local.title,'Filter returned products');assert.match(local.summary,/8 products checked; 3 kept/);assert.match(local.description,/no new catalog request/);
});
