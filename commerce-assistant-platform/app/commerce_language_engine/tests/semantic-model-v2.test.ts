import './recognition-test-context.ts';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {resolve} from '../src/engine.ts';

function model() {
 const d=buildExpandedDictionary();
 d.schemaVersion=2;
 const intent=d.intents.find(i=>i.code==='ADD_TO_CART')!;
 const frame=d.actionFrames!.find(f=>f.intent==='ADD_TO_CART')!;
 const source=d.groups[0]!.code,target=d.groups[1]!.code;
 const entityType=d.entity_terms[0]!.type;
 const industry=d.entity_terms[0]!.industry;
 d.semanticModel={
  industryPacks:[...new Set(d.entity_terms.map(x=>x.industry))],entityTypes:[...new Set(d.entity_terms.map(x=>x.type))],operators:[],
  intentSlots:[{intent:intent.code,code:'ITEMS',entityType,valueType:'ENTITY',requirement:'REQUIRED',minCount:1,maxCount:null,clarificationRank:10,resolutionStrategy:'EXTRACT',version:1,metadata:{}}],
  semanticRelationships:[{source,relation:'IMPLIES',target,industry,weight:1,directional:true,version:1,metadata:{}}],
  compositionRules:[{code:'QUANTITY_PRODUCT',leftKind:'QUANTITY',leftRef:null,relation:'MODIFIES',rightKind:'ENTITY',rightRef:null,outputKind:'ITEM',outputTemplate:{quantity:'$left',product:'$right'},precedence:10,score:1,industry,version:1}],
  actionFrameSlots:[{frame:frame.code,role:'OBJECT',semanticGroup:source,requirement:'REQUIRED',cardinality:'ONE_OR_MORE',positionalHint:{},version:1}],
  ambiguities:[{term:'apple',candidateKind:'ENTITY_TYPE',candidateRef:entityType,industry,priorWeight:1,requiredContext:{},disambiguationPolicy:'SCORE',version:1}],
  referenceRules:[{code:'IT',referenceGroup:source,targetKind:'ENTITY',selectionStrategy:'LATEST_COMPATIBLE',constraints:{},precedence:10,version:1}],
  clarificationPolicies:[{intent:intent.code,slotCode:'ITEMS',questionTemplate:'Which items?',candidateMode:'COMMERCE',maxAttempts:2,priority:10,version:1}],
  confidenceCalibrations:[],industryPackRelations:[],
 };
 return d;
}

test('compiler accepts V2 semantic definitions and preserves V1 turn behavior',()=>{
 const d=model();const compiled=compile(d);const baseline=compile(buildExpandedDictionary());
 assert.equal(compiled.schemaVersion,2);assert.equal(baseline.schemaVersion,1);
 assert.equal(resolve(compiled,'add two shirts to my cart').intent,resolve(baseline,'add two shirts to my cart').intent);
 assert.equal(resolve(compiled,'add two shirts to my cart').entities.quantity,resolve(baseline,'add two shirts to my cart').entities.quantity);
});

test('compiler rejects semantic graph references that do not resolve',()=>{
 const d=model();d.semanticModel!.semanticRelationships[0]!.target='MISSING_GROUP';
 assert.throws(()=>compile(d),/Invalid semantic relationship/);
});

test('compiler rejects industry inheritance cycles',()=>{
 const d=model();const [parent,child]=d.semanticModel!.industryPacks;
 if(!parent||!child||parent===child) return;
 d.semanticModel!.industryPackRelations=[
  {parent,child,inheritTerms:true,inheritRules:true,inheritEntities:true,inheritRelationships:true,precedence:1},
  {parent:child,child:parent,inheritTerms:true,inheritRules:true,inheritEntities:true,inheritRelationships:true,precedence:1},
 ];
 assert.throws(()=>compile(d),/inheritance cycle/);
});

test('compiler rejects conflicting composition rules with the same scope and precedence',()=>{
 const d=buildExpandedDictionary();
 d.semanticModel!.compositionRules.push({...d.semanticModel!.compositionRules[0]!,code:'CONFLICTING_COMPOSITION',outputTemplate:{edgeRelation:'DIFFERENT'},precedence:d.semanticModel!.compositionRules[0]!.precedence});
 assert.throws(()=>compile(d),/Conflicting composition rules/);
});

test('V2 database migration is additive and privacy-conscious',async()=>{
 const up=await readFile(new URL('../migrations/005_semantic_model_v2.sql',import.meta.url),'utf8');
 for(const name of ['intent_slots','semantic_relationships','semantic_composition_rules','action_frame_slots','semantic_ambiguities','reference_rules','clarification_policies','resolution_feedback','confidence_calibrations','industry_pack_relations'])assert.match(up,new RegExp(`CREATE TABLE IF NOT EXISTS ${name}\\b`));
 assert.doesNotMatch(up,/raw_utterance|customer_text/i);
 assert.match(up,/utterance_hash/);
});

test('corpus migration accepts every difficulty label emitted by the generator',async()=>{
 const up=await readFile(new URL('../migrations/006_corpus_difficulty_v2.sql',import.meta.url),'utf8');
 for(const label of ['EASY','MEDIUM','HARD','AMBIGUOUS','CONTEXT_REQUIRED','NEGATIVE_CONFLICT','TYPO_NOISE','PARAPHRASE','REFERENCE','NEGATION','HARD_NEGATIVE','INCOMPLETE','COMPOUND'])assert.match(up,new RegExp(`'${label}'`));
});

test('composition rule ownership metadata is additive',async()=>{
 const up=await readFile(new URL('../migrations/008_composition_rule_metadata.sql',import.meta.url),'utf8');
 assert.match(up,/ALTER TABLE semantic_composition_rules ADD COLUMN IF NOT EXISTS metadata/);
});

test('reference and ambiguity ownership metadata is additive',async()=>{
 const up=await readFile(new URL('../migrations/009_reference_ambiguity_metadata.sql',import.meta.url),'utf8');
 assert.match(up,/ALTER TABLE reference_rules ADD COLUMN IF NOT EXISTS metadata/);
 assert.match(up,/ALTER TABLE semantic_ambiguities ADD COLUMN IF NOT EXISTS metadata/);
});

test('phase 7 confidence artifacts cannot be promoted after held-out Brier regression',async()=>{
 const {promotionBlockers}=await import('../src/artifact-promotion.ts');
 const artifact={dictionaryVersion:7,generationFingerprint:'local',runtimePromotion:'DISABLED',provenance:{source:'generated-corpus',sampleCount:5000},evaluationGate:{brierScoreRegressed:true,passed:false}};
 assert.ok(promotionBlockers(artifact,{dictionaryVersion:7,generationFingerprint:'local'},['CREATE_ORDER']).length>=4);
});

test('phase 8 durable pending sessions migration has tenant isolation, revision and expiry guards',async()=>{
 const up=await readFile(new URL('../migrations/010_pending_clarification_sessions.sql',import.meta.url),'utf8');
 for(const rule of [/PRIMARY KEY\(tenant_id,session_id\)/,/revision integer NOT NULL CHECK\(revision>0\)/,/expires_at timestamptz NOT NULL/,/cancelled_at timestamptz/])assert.match(up,rule);
});
