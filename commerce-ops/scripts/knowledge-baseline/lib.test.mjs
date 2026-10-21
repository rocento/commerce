import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseJsonSequence,classifyHistorical,classifyCurrent,percentile,familySplit,validateBenchmarkApproval,sha256} from './lib.mjs';
test('SQL JSON stream handles nested pretty JSON and quoted braces',()=>{
 assert.deepEqual(parseJsonSequence('{"kind":"x","text":"escaped \\\" }"}\n[\n{"Plan":{"x":1}}\n]'),[{kind:'x',text:'escaped " }'},[{Plan:{x:1}}]]);
 assert.throws(()=>parseJsonSequence('{"x":'),/Incomplete/);
 assert.throws(()=>parseJsonSequence('ERROR'),/non-JSON/);
});
test('no-match symptoms do not fabricate retrieval failure or missing facts',()=>{
 const result=classifyHistorical({failure_categories:'unhelpful_no_match',assistant_responses:'I cannot verify a match.'});
 assert.deepEqual(result.categories,['unattributed_no_match']);
 assert.equal(result.missingCatalogEvidence,'not_established_by_saved_grade');
 assert.equal(result.evaluationError,'requires_independent_review');
 assert.equal(result.missingEvidenceSignal,true);
});
test('unknown historical labels fail loudly instead of disappearing',()=>{
 assert.throws(()=>classifyHistorical({failure_categories:'new_label'}),/Unmapped/);
});
test('multi-category cases preserve context and interpretation symptoms',()=>{
 assert.deepEqual(classifyHistorical({failure_categories:'context_loss;catalog_filter_leak'}).categories,['context','interpretation']);
 assert.deepEqual(classifyCurrent({failures:[{code:'budget_followup_value'},{code:'family_route'}]}),['context','interpretation']);
});
test('reservation remains at whole-family granularity and includes both splits',()=>{
 assert.equal(familySplit('compatibility'),familySplit('compatibility'));
 assert.equal(new Set(Array.from({length:50},(_,i)=>familySplit('family'+i))).size,2);
});
test('nearest-rank percentiles handle boundaries and empty samples',()=>{
 assert.equal(percentile([], .95),null);assert.equal(percentile([5,1,2,4,3],.5),3);assert.equal(percentile([5,1,2,4,3],.95),5);
});
const proposalBytes=readFileSync(new URL('../../output/enterprise-knowledge-phase0-20261010/benchmark-candidate.json',import.meta.url));
const proposal=JSON.parse(proposalBytes);
const approved=JSON.parse(readFileSync(new URL('../../output/enterprise-knowledge-phase0-20261010/benchmark-approved.json',import.meta.url)));
test('owner approval preserves prompts, family reservation, and review provenance',()=>{
 assert.equal(validateBenchmarkApproval(approved,proposal,sha256(proposalBytes)),true);
});
test('approval cannot disguise execution, human review, changed prompts, or split leakage',()=>{
 for(const mutate of [x=>x.humanReviewed=true,x=>x.executed=true,x=>x.cases[0].turns=['changed prompt'],x=>x.cases[2].split='development',x=>x.approval.conditionSatisfied=false]){
  const broken=structuredClone(approved);mutate(broken);
  assert.throws(()=>validateBenchmarkApproval(broken,proposal,sha256(proposalBytes)));
 }
});
