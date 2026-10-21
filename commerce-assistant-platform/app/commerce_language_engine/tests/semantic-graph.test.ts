import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {clauses} from '../src/semantic-clauses.ts';
import {buildSemanticGraph,MAX_SEMANTIC_GRAPH_EDGES,MAX_SEMANTIC_GRAPH_NODES} from '../src/semantic-graph.ts';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import type {SemanticCompositionRule} from '../src/types.ts';

const runtime=await loadRuntime();

test('compound requests expose action-item, quantity and sequence graph edges',()=>{
 const result=resolve(runtime,'add two apples and one milk then checkout');
 const graph=result.graph;
 assert.ok(graph);assert.equal(graph.truncated,false);
 assert.deepEqual(graph.edges.filter(edge=>edge.relation==='TARGETS').map(edge=>[edge.from,edge.to]),[['action1','item1'],['action1','item2']]);
 assert.ok(graph.edges.some(edge=>edge.relation==='HAS_QUANTITY'&&edge.from==='item1'&&edge.to==='quantity1'));
 assert.ok(graph.edges.some(edge=>edge.relation==='SEQUENCE_NEXT'&&edge.from==='action1'&&edge.to==='action2'&&edge.ruleCode==='ACTION_SEQUENCE'));
 assert.ok(graph.edges.filter(edge=>edge.relation==='TARGETS').every(edge=>edge.ruleCode==='ACTION_TARGETS_ITEM'));
 assert.ok(graph.edges.some(edge=>edge.relation==='PERFORMS'&&edge.from==='clause1'&&edge.to==='action1'));
 assert.deepEqual(graph.constraints,['quantity1','quantity2']);
});

test('coordinators inside arguments are not blindly treated as clause boundaries',()=>{
 const parsed=clauses('find salt and pepper',runtime.dictionary);
 assert.equal(parsed.length,1);assert.equal(parsed[0]?.intent,'PRODUCT_SEARCH');
 assert.match(parsed[0]?.text??'',/salt and pepper/);
});

test('graph output stays within explicit node and edge budgets',()=>{
 const items=Array.from({length:400},(_,i)=>({productText:`product ${i}`,quantity:i+1}));
 const result=buildSemanticGraph({primaryIntent:'CREATE_ORDER',clauses:[],actions:[],items,slots:[],references:[],relationships:[],compositionRules:[]});
 assert.ok(result.nodes.length<=MAX_SEMANTIC_GRAPH_NODES);assert.ok(result.edges.length<=MAX_SEMANTIC_GRAPH_EDGES);assert.equal(result.truncated,true);
});

test('compiled composition index selects deterministic typed edge rules',()=>{
 const rules:SemanticCompositionRule[]=[
  {code:'z',leftKind:'ACTION',leftRef:null,relation:'precedes',rightKind:'ACTION',rightRef:null,outputKind:'EDGE',outputTemplate:{edgeRelation:'SEQUENCE_NEXT'},precedence:10,score:1,version:1},
  {code:'a',leftKind:'ACTION',leftRef:null,relation:'precedes',rightKind:'ACTION',rightRef:null,outputKind:'EDGE',outputTemplate:{edgeRelation:'SEQUENCE_NEXT'},precedence:5,score:1,version:1},
 ];
 const dictionary=buildExpandedDictionary();dictionary.semanticModel!.compositionRules=rules;const compiled=compile(dictionary);
 const result=buildSemanticGraph({primaryIntent:'START_CHECKOUT',clauses:[],actions:[{id:'a1',intent:'ADD_TO_CART',clauseId:'c1',operation:'ADD_ITEM'},{id:'a2',intent:'START_CHECKOUT',clauseId:'c2',operation:'START_CHECKOUT'}],items:[],slots:[],references:[],relationships:[{from:'a1',relation:'precedes',to:'a2'}],compositionRules:rules,compositionBySignature:compiled.compositionBySignature});
 assert.equal(result.edges[0]?.ruleCode,'a');
});
