import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {buildKnowledge} from '../src/knowledge.ts';
import {resolve} from '../src/engine.ts';
import {scoringConfig,scoreConfidence} from '../src/scoring.ts';
import type {Candidate} from '../src/types.ts';
const dictionary=buildExpandedDictionary(),compiled=compile(dictionary);
const candidate=(score:number,intent='test'):Candidate=>({intent,score,evidence:[],penalties:[],missing:[],contextBoost:0});
test('requested regression cases resolve intent before entity completeness',()=>{
 for(const c of [compiled,compile(buildKnowledge())]) {
  const incomplete=resolve(c,'add two items to cart');
  assert.equal(incomplete.status,'NEEDS_CONTEXT');assert.equal(incomplete.intent,'ADD_TO_CART');assert.ok(incomplete.missing?.some((key:string)=>['items[0].productText','productReference'].includes(key)));
  const complete=resolve(c,'add strawberries to cart');assert.equal(complete.status,'RESOLVED');assert.equal(complete.intent,'ADD_TO_CART');
  assert.equal(incomplete.confidence,complete.confidence);
  assert.notEqual(resolve(c,"don't add this to cart").intent,'ADD_TO_CART');
  assert.equal(resolve(c,'new order').status,'AMBIGUOUS');
  assert.equal(resolve(c,'please I need help').status,'UNKNOWN');
 }
});
test('action and destination contribute 4 + 4 + 5 and request markers only once',()=>{
 const r=resolve(compiled,'pls i need add two fresh items in cart');
 assert.equal(r.debug.score,13.25);assert.equal(r.status,'NEEDS_CONTEXT');
 assert.deepEqual(r.evidence.map(e=>e.score),[4,4,5,0.25]);
 assert.equal(resolve(compiled,'please please i need want add two items to cart').debug.score,13.25);
});
test('negated actions retain explicit penalties and cannot be rescued by a frame',()=>{
 const r=resolve(compiled,"don't add this to cart");
 const add=r.debug.candidates.find(c=>c.intent==='ADD_TO_CART')!;
 assert.ok(add.penalties.some(p=>p.kind==='NEGATED_REQUIRED_ACTION'&&p.score===-8));
 assert.ok(add.penalties.some(p=>p.kind==='MISSING_REQUIRED_INTENT_SIGNAL'&&p.score===-5));
 assert.ok(add.score<6);
});
test('softmax and multiplicative confidence match the specification',()=>{
 const c=[candidate(13),candidate(3)];const m=scoreConfidence(c,scoringConfig());
 assert.ok(Math.abs(m.probability-1/(1+Math.exp(-5)))<1e-12);
 assert.equal(m.confidence,m.probability);assert.equal(m.scoreMargin,10);
 const close=scoreConfidence([candidate(10),candidate(9)],scoringConfig());
 assert.ok(Math.abs(close.confidence-(1/(1+Math.exp(-0.5)))*(10/12)*(1/5))<1e-12);
 assert.equal(scoreConfidence([candidate(13),candidate(13)],scoringConfig()).confidence,0);
 assert.equal(scoreConfidence([candidate(-1)],scoringConfig()).confidence,0);
 assert.equal(scoreConfidence([],scoringConfig()).confidence,0);
});
test('softmax is stable for large values, normalized, and temperature configurable',()=>{
 const c=[candidate(10000),candidate(9990)];const m=scoreConfidence(c,scoringConfig());
 assert.ok(Number.isFinite(m.confidence));assert.ok(Math.abs(c.reduce((n,c)=>n+c.probability!,0)-1)<1e-12);
 assert.ok(scoreConfidence([candidate(13),candidate(3)],scoringConfig({temperature:4})).probability<m.probability);
});
test('configuration controls weights, penalties and each decision threshold',()=>{
 const text='add strawberries to cart';
 assert.equal(resolve(compiled,text,{}, {weights:{required:3,relationship:4}}).debug.score,10);
 assert.equal(resolve(compiled,text,{}, {minScore:14}).status,'UNKNOWN');
 for(const options of [{minConfidence:1},{minScoreMargin:100},{minProbabilityMargin:1},{targetStrongScore:100},{targetMargin:100},{temperature:100}])assert.equal(resolve(compiled,text,{},options).status,'AMBIGUOUS');
 const r=resolve(compiled,"don't add this to cart",{}, {penalties:{negatedAction:12,missingRequired:7}});
 assert.ok(r.debug.candidates.find(c=>c.intent==='ADD_TO_CART')!.penalties.some(p=>p.score===-12));
 for(const options of [{temperature:0},{temperature:NaN},{targetMargin:0},{minConfidence:2},{weights:{required:-1}}])assert.throws(()=>scoringConfig(options),/Invalid scoring/);
});
test('duplicate overlapping semantic conditions and templates do not multiply evidence',()=>{
 const d=structuredClone(dictionary),intent=d.intents.find(i=>i.code==='ADD_TO_CART')!;
 const group=intent.conditions[0].group;const original=d.groups.find(g=>g.code===group)!;
 d.groups.push({...original,code:'ACTION_OVERLAP'});
 intent.conditions.push({group:'ACTION_OVERLAP',kind:'REQUIRED',score:999},{group,kind:'BOOST',score:999});
 d.patterns.push({intent:intent.code,groups:[group],score:999});
 assert.equal(resolve(compile(d),'add strawberries to cart').debug.score,13);
});
test('missing business entities cannot affect scores or confidence',()=>{
 const d=structuredClone(dictionary);d.intents.find(i=>i.code==='ADD_TO_CART')!.requiredEntities=['productId'];
 const before=resolve(compiled,'add strawberries to cart'),after=resolve(compile(d),'add strawberries to cart');
 assert.equal(after.status,'NEEDS_CONTEXT');assert.deepEqual(after.missing,['productId']);
 assert.equal(after.confidence,before.confidence);assert.deepEqual(after.debug.candidates,before.debug.candidates);
 assert.deepEqual(after.context.next,{pendingRequest:'add strawberries to cart'});
});
test('destination contradictions use configured penalty rather than a frame override',()=>{
 const r=resolve(compiled,'add two cart organizers to my wishlist');
 assert.equal(r.intent,'ADD_TO_WISHLIST');assert.equal(r.debug.score,13);
 assert.ok(r.debug.candidates.find(c=>c.intent==='ADD_TO_CART')!.penalties.some(p=>p.kind==='CONTRADICTORY_DESTINATION'&&p.score===-6));
});

test('recency modifiers remain compositional and explicit actions separate their meanings',()=>{
 for(const modifier of ['new','recent','latest']){
  assert.equal(resolve(compiled,modifier+' order').status,'AMBIGUOUS');
  assert.equal(resolve(compiled,'create '+modifier+' order').intent,'CREATE_ORDER');
  const r=resolve(compiled,'show '+modifier+' order');
  assert.notEqual(r.intent,'CREATE_ORDER');
  assert.ok(r.debug.candidates.find(c=>c.intent==='ORDER_DETAILS')!.score>r.debug.candidates.find(c=>c.intent==='CREATE_ORDER')!.score);
 }
});
test('quantity clarification does not invent a missing concrete product reference',()=>{
 const r=resolve(compiled,'add two or three strawberries to cart');
 assert.equal(r.status,'NEEDS_CONTEXT');assert.deepEqual(r.missing,['quantity']);
});
