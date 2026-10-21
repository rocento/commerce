import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256} from './lib.mjs';
import {knowledgeHash} from '../../commerce-assistant-platform/app/commerce_language_engine/src/language-knowledge.ts';
import {runtimeSha256} from '../../commerce-assistant-platform/app/commerce_language_engine/src/runtime-identity.ts';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url))),out=join(root,'output/enterprise-knowledge-phase2-fixes-20261010'),prior=join(root,'output/enterprise-knowledge-phase2-20261010'),phase0=join(root,'output/enterprise-knowledge-phase0-20261010');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const snapshot=read(join(out,'snapshot-manifest.json'));
for(const [path,hash] of Object.entries(snapshot.files)){
 assert.equal(sha256(readFileSync(join(out,'engine',path))),hash);
 if(path!=='data/compiled.json')assert.equal(sha256(readFileSync(join(root,'commerce-assistant-platform/app/commerce_language_engine',path))),hash,'Source changed since freeze: '+path);
}
for(const [path,hash] of Object.entries(snapshot.pythonBoundary)){assert.equal(sha256(readFileSync(join(root,path))),hash);assert.equal(sha256(readFileSync(join(out,'python',path))),hash);}
for(const [path,hash] of Object.entries(read(join(prior,'snapshot-manifest.json')).files))assert.equal(sha256(readFileSync(join(prior,'engine',path))),hash,'Revision 7 snapshot changed');
for(const [path,hash] of Object.entries(read(join(prior,'verification.json')).artifacts))assert.equal(sha256(readFileSync(join(prior,path))),hash,'Revision 7 evidence changed');
const oldSnapshot=read(join(phase0,'snapshot-manifest.json'));
for(const source of oldSnapshot.sources)assert.equal(sha256(readFileSync(join(root,source.path))),source.sha256);
for(const [path,hash] of Object.entries(oldSnapshot.engineFiles))assert.equal(sha256(readFileSync(join(phase0,'engine',path))),hash);
assert.equal(read(join(phase0,'benchmark-approved.json')).executed,false);
const candidate=read(join(out,'candidate.json')),pack=candidate.languageKnowledge,previous=read(join(prior,'candidate.json'));
assert.deepEqual(candidate.entity_terms,previous.entity_terms);assert.equal(pack.revision,8);
assert.equal(knowledgeHash(pack),knowledgeHash(read(join(root,'commerce-assistant-platform/app/commerce_language_engine/data/knowledge/shopping-en-phase2-v2.json'))));
const {generationFingerprint:_fingerprint,corpus:_corpus,...content}=candidate;assert.equal(candidate.generationFingerprint,knowledgeHash(content));
const replay=read(join(out,'offline-language-replay.json')),before=read(join(prior,'offline-language-replay.json'));
assert.equal(replay.summary.conversations,4000);assert.equal(replay.summary.turns,4675);assert.equal(replay.comparison.regressedChecks,0);
for(const key of ['csvSha256','rubricSha256'])assert.equal(replay.provenance[key],before.provenance[key]);
assert.equal(replay.provenance.generationFingerprint,candidate.generationFingerprint);
const fresh=read(join(out,'reserved-validation.json')),regression=read(join(out,'original-regression.json'));
for(const [folder,report,count] of [[out,fresh,24],[prior,regression,28]]){
 const lock=read(join(folder,'validation-lock.json'));assert.equal(sha256(readFileSync(join(folder,'validation-reserved.json'))),lock.sha256);assert.equal(report.expectedSha256,lock.sha256);assert.equal(report.fingerprint,candidate.generationFingerprint);
 assert.equal(report.counts.candidatePassed,count);assert.equal(report.counts.conversations,count);assert.equal(report.counts.regressions,0);
}
assert.equal(regression.counts.improvements,3);
const perf=read(join(out,'local-performance.json')),oldPerf=read(join(prior,'local-performance.json'));
for(const key of ['node','platform','arch','cpu','logicalCpus'])assert.equal(perf.environment[key],oldPerf.environment[key]);
const p95Ratio=perf.latency.p95Ms/oldPerf.latency.p95Ms,rssRatio=perf.memory.processMaxRssKiB/oldPerf.memory.processMaxRssKiB;
assert.ok(p95Ratio<=1.2);assert.ok(rssRatio<=1.2);
const runtime=await runtimeSha256(pathToFileURL(join(out,'engine/')));assert.equal(runtime,perf.identity.runtimeSha256);assert.equal(perf.identity.fingerprint,candidate.generationFingerprint);
const local=read(join(out,'local-state.json'));assert.equal(local.candidate.fingerprint,candidate.generationFingerprint);assert.equal(local.candidate.packSha256,knowledgeHash(pack));assert.equal(local.activated,false);assert.equal(local.recordContentVerified,true);assert.equal(local.migration,'030_person_composition_policy.sql');
const node=readFileSync(join(out,'node-tests.log'),'utf8'),python=readFileSync(join(out,'python-tests.log'),'utf8'),typecheck=readFileSync(join(out,'typecheck.log'),'utf8');assert.match(node,/ℹ pass 703/);assert.match(node,/ℹ fail 0/);assert.match(node,/ℹ skipped 0/);assert.match(python,/205 passed/);assert.doesNotMatch(typecheck,/error TS\d+/);
const oldConcepts=new Map(previous.languageKnowledge.concepts.map(c=>[c.id,c]));
const vocabulary={added:pack.concepts.filter(c=>!oldConcepts.has(c.id)),amended:pack.concepts.filter(c=>oldConcepts.has(c.id)&&knowledgeHash(c)!==knowledgeHash(oldConcepts.get(c.id))).map(c=>({before:oldConcepts.get(c.id),after:c}))};
writeFileSync(join(out,'vocabulary-changes.json'),JSON.stringify(vocabulary,null,2)+'\n');
const oldRules=new Map(previous.languageKnowledge.ruleGovernance.map(r=>[r.family+':'+r.ruleId,r]));
const changed=pack.ruleGovernance.filter(r=>oldRules.get(r.family+':'+r.ruleId)?.definitionSha256!==r.definitionSha256).map(r=>({before:oldRules.get(r.family+':'+r.ruleId),after:r}));
writeFileSync(join(out,'rule-changes.json'),JSON.stringify(changed,null,2)+'\n');
const artifacts=['snapshot-manifest.json','candidate.json','candidate-report.json','local-candidate.json','local-state.json','offline-language-replay.json','local-performance.json','reserved-validation.json','original-regression.json','validation-lock.json','validation-reserved.json','node-tests.log','python-tests.log','typecheck.log','vocabulary-changes.json','rule-changes.json'];
const report={verifiedAt:new Date().toISOString(),localChecksPassed:true,threeFindingsClosed:true,productionReady:false,runtimeSha256:runtime,fingerprint:candidate.generationFingerprint,packSha256:knowledgeHash(pack),checks:{currentSourcesMatchFrozenCandidate:true,priorSnapshotsAndReportsPreserved:true,phase0ReservedExecuted:false,nodeTestsPassed:703,pythonTestsPassed:205,regressedHistoricalChecks:replay.comparison.regressedChecks,improvedHistoricalChecks:replay.comparison.improvedChecks,changedEntityRows:replay.rows.filter((r,i)=>knowledgeHash(r.entities)!==knowledgeHash(before.rows[i].entities)).length,originalRegression:regression.counts,freshValidation:fresh.counts,p95ChangePercent:100*(p95Ratio-1),peakRssChangePercent:100*(rssRatio-1),localCandidateContentVerified:true,localCandidateActivated:false},openValidationCases:[],artifacts:Object.fromEntries(artifacts.map(name=>[name,sha256(readFileSync(join(out,name)))]))};
writeFileSync(join(out,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.checks,null,2));
