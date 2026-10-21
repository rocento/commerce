import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {customerJourney} from '../journey.mjs';
import {stepFacts,traceDiagnostics} from '../public/trace-diagnostics.js';
const fixtures=JSON.parse(await readFile(new URL('./fixtures/trace-diagnostics.json',import.meta.url),'utf8'));
const diagnostic=name=>customerJourney(fixtures[name]).diagnostics;

test('completed lifecycle and handler marker do not invent task fulfillment or latency',()=>{
 const d=diagnostic('completedWithoutProof');
 assert.equal(d.execution.value,'completed');assert.equal(d.businessOutcome.value,'unknown');
 assert.equal(d.goal.value,'PRODUCT_SEARCH');assert.equal(d.metrics.requestDuration.value,null);
 assert.equal(d.metrics.modelCalls.value,null);assert.equal(d.metrics.inputTokens.value,null);
 assert.equal(d.findings[0].id,'filter:step-3');assert.deepEqual(d.findings[0].evidence,['step-3']);
 assert.match(d.findings[0].description,/Per-check effects are not captured/);
});

test('pending and failure outcomes outrank success text and completion markers',()=>{
 assert.equal(diagnostic('clarification').businessOutcome.value,'clarification_needed');
 assert.equal(diagnostic('clarification').execution.value,'completed');
 assert.equal(diagnostic('denied').businessOutcome.value,'blocked');
 assert.equal(diagnostic('failed').businessOutcome.value,'failed');
 assert.equal(diagnostic('legacy').businessOutcome.value,'unknown');
 assert.equal(diagnostic('legacy').execution.value,'completion_not_captured');
});

test('prepared requests do not count as calls; observed usage remains partial and preserves zero',()=>{
 const d=diagnostic('modelRecovery');assert.equal(d.metrics.modelCalls.value,null);
 assert.equal(d.metrics.inputTokens.value,100);assert.equal(d.metrics.outputTokens.value,12);
 assert.deepEqual(d.metrics.inputTokens.evidence,['step-4']);
 assert.match(d.metrics.inputTokens.note,/not total request usage/);
 assert.equal(d.metrics.estimatedCost.value,null);assert.equal(d.capture.truncated,true);
 assert.equal(d.findings[0].title,'AI response failed validation');
 assert.equal(d.execution.value,'completed');assert.ok(d.findings.some(f=>f.id==='fallback'));
 const response=customerJourney(fixtures.modelRecovery).steps.find(s=>s.id==='step-4');
 assert.equal(stepFacts(response).find(f=>f.key==='output').value,0);
 assert.equal(stepFacts(response).find(f=>f.key==='validation').state,'not_recorded');
});

test('retrieval failure and no examples remain distinct observations, not task failure',()=>{
 for(const status of ['empty','unavailable','unconfigured']){
  const d=customerJourney({events:[{stage:'intent_retrieval',data:{status}}]}).diagnostics;
  assert.equal(d.businessOutcome.value,'unknown');assert.match(d.findings[0].description,/alone does not establish request failure/);
 }
});

test('ordering preserves evidence identity, call identity and separate concurrent results',()=>{
 const journey=customerJourney(fixtures.concurrent);
 assert.deepEqual(journey.steps.map(s=>s.id),['step-1','step-0']);
 assert.deepEqual(journey.steps.map(s=>s.eventIndex),[1,0]);
 assert.deepEqual(journey.steps.map(s=>s.callId),[1,2]);
 assert.equal(journey.steps[0].evidence.details.criteria.query,'pears');
 assert.equal(journey.diagnostics.metrics.requestDuration.value,null);
 assert.deepEqual(journey.diagnostics.findings[0].evidence,['step-1']);
});

test('missing, redacted and truncated metadata do not become fabricated completeness',()=>{
 assert.equal(diagnostic('legacy').capture.redacted,null);
 assert.equal(diagnostic('legacy').capture.timing,'not_recorded');
 assert.equal(diagnostic('legacy').capture.modelInput,'not_recorded');
 assert.equal(traceDiagnostics({steps:[]}).capture.terminal,'not_recorded');
 const d=customerJourney({events:[{stage:'customer_request',data:{_journey:{atMs:0}}},{stage:'unknown',data:{}}]}).diagnostics;
 assert.equal(d.capture.timing,'partial');
});

test('every finding and fact references an existing event and projections do not mutate reports',()=>{
 for(const report of Object.values(fixtures)){
  const before=JSON.stringify(report),journey=customerJourney(report),ids=new Set(journey.steps.map(s=>s.id));
  for(const item of [...journey.diagnostics.findings,...journey.steps.flatMap(stepFacts)])for(const id of item.evidence)assert.ok(ids.has(id));
  assert.equal(JSON.stringify(report),before);
 }
});

test('rules expose captured comparisons without substituting definitions for condition evidence',()=>{
 const step={id:'rule',stage:'language_rule_evidence',evidence:{diagnostics:{normalizedText:'find fruit'},result:{entities:{priceMax:200}}},rules:{candidates:[{selected:true,observed:{intent:'SEARCH',rule:'primary',score:9,evidence:[],missing:['stock']}},{selected:false,observed:{intent:'BROWSE',score:5}}]}};
 const facts=stepFacts(step);assert.equal(facts.find(f=>f.key==='margin').value,4);assert.match(facts.find(f=>f.key==='margin').note,/not a probability/);
 step.rules.candidates[1].observed.score='5';assert.equal(stepFacts(step).find(f=>f.key==='margin').value,null);
});

const v2=JSON.parse(await readFile(new URL('./fixtures/trace-capture-v2.json',import.meta.url),'utf8'));
test('v2 reports expose policy completion, compatible lifecycle metrics and nonduplicated provider usage',()=>{
 const journey=customerJourney(v2),d=journey.diagnostics;
 assert.equal(d.version,2);assert.equal(d.execution.value,'completed');assert.equal(d.businessOutcome.value,'clarification_needed');
 assert.equal(d.metrics.requestDuration.value,31);assert.equal(d.metrics.firstText.value,27);assert.equal(d.metrics.modelCalls.value,1);assert.equal(d.metrics.inputTokens.value,10);
 const provider=journey.steps.find(s=>s.stage==='provider_attempt');assert.equal(provider.parentSpanId,'span-1');assert.equal(provider.id,'span:span-2');
 const filter=journey.steps.find(s=>s.stage==='catalog_filter');assert.deepEqual(stepFacts(filter).map(f=>f.value),['12 → 3 products','3 → 0 products']);
 assert.match(d.findings.find(f=>f.id.startsWith('filter:')).title,/stock requirement/);
});
test('new completion policy must include authoritative success evidence and cannot override failure',()=>{
 const report=structuredClone(v2),last=report.events.at(-1).data;
 last.language_gate.status='RESOLVED';last.completion={version:1,status:'completed',request_completed:true,task_completed:true,evidence:'action_receipt'};
 assert.equal(customerJourney(report).diagnostics.businessOutcome.value,'fulfilled');
 last.completion.evidence=null;assert.equal(customerJourney(report).diagnostics.businessOutcome.value,'unknown');
 last.completion.evidence='action_receipt';last.outcome='denied';assert.equal(customerJourney(report).diagnostics.businessOutcome.value,'blocked');
});
test('clock mismatch, impossible timing and incomplete provider usage stay unknown',()=>{
 const report=structuredClone(v2),last=report.events.at(-1).data;
 last.measurements.trace_id='another-request';assert.equal(customerJourney(report).diagnostics.metrics.requestDuration.value,null);
 last.measurements.trace_id=report.request_id;last.measurements.first_text_ms=999;assert.equal(customerJourney(report).diagnostics.metrics.firstText.value,null);
 last.provider_totals={version:1,scope:'openai_responses_dispatch',attempts:1,completed:0,input_tokens:0,output_tokens:0,usage_complete:false};
 let d=customerJourney(report).diagnostics;assert.equal(d.metrics.inputTokens.value,null);assert.equal(d.metrics.modelCalls.value,1);
 last.provider_totals.attempts=0;last.provider_totals.usage_complete=true;d=customerJourney(report).diagnostics;assert.equal(d.metrics.inputTokens.value,0);
});
test('only explicit complete example identities establish prepared-input inclusion',()=>{
 const report=structuredClone(v2);let journey=customerJourney(report);
 assert.equal(journey.steps.find(s=>s.stage==='intent_retrieval').modelInputEvidence.count,1);
 report.events[2].data.included_example_refs[0].revision=2;journey=customerJourney(report);assert.equal(journey.steps.find(s=>s.stage==='intent_retrieval').modelInputEvidence,undefined);
 report.events[1].data.example_refs=[{}];report.events[2].data.included_example_refs=[{}];journey=customerJourney(report);assert.equal(journey.steps.find(s=>s.stage==='intent_retrieval').modelInputEvidence,undefined);
});
test('stable v2 span identity coalesces live start/completion and never merges unrelated events',()=>{
 const start={stage:'python_function_start',data:{function:'resolve',callId:1,outcome:'running',_journey:{eventId:'start-1',spanId:'span-1',parentSpanId:null,atMs:0,startMs:0,clockDomain:'python-perf-counter'}}};
 const running=customerJourney({events:[start]});assert.equal(running.steps[0].id,'span:span-1');
 for(const events of [[start,...v2.events],[...v2.events,start]]){
  const journey=customerJourney({...v2,events});assert.equal(journey.steps.filter(s=>s.id==='span:span-1').length,1);assert.equal(journey.steps.find(s=>s.id==='span:span-1').evidence.outcome,'returned');assert.equal(journey.steps.length,v2.events.length);
 }
});
test('inconsistent filter counts are not presented as an explanation',()=>{
 const report=structuredClone(v2);report.events[5].data.check_steps[1].before=5;
 const journey=customerJourney(report),step=journey.steps.find(s=>s.stage==='catalog_filter');
 assert.equal(stepFacts(step)[0].state,'not_recorded');assert.doesNotMatch(journey.diagnostics.findings.find(f=>f.id.startsWith('filter:')).title,/stock/);
});
