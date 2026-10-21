// Verify saved preparation evidence. Success here never overrides a failed release gate.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {decodeReleaseBundle} from '../../commerce-assistant-platform/app/commerce_language_engine/scripts/deployment-release.ts';
import {runtimeSha256} from '../../commerce-assistant-platform/app/commerce_language_engine/src/runtime-identity.ts';

const root=resolve(import.meta.dirname,'../..');
const out=resolve(process.argv[2]??join(root,'output/enterprise-knowledge-release-prep-20261010'));
const json=name=>JSON.parse(readFileSync(join(out,name),'utf8'));
const hash=body=>createHash('sha256').update(body).digest('hex');
const snapshot=json('runtime-snapshot.json');
for(const [name,expected] of Object.entries(snapshot.files)){
 assert.equal(hash(readFileSync(join(out,'engine',name))),expected,'Frozen runtime changed: '+name);
 if(name.startsWith('src/')||name.startsWith('migrations/')||name==='package-lock.json')assert.equal(hash(readFileSync(join(root,'commerce-assistant-platform/app/commerce_language_engine',name))),expected,'Current runtime changed: '+name);
}
for(const [name,expected] of Object.entries(snapshot.preserved))assert.equal(hash(readFileSync(join(root,name))),expected,'Historical evidence changed: '+name);
for(const component of ['language','python']){
 const manifest=json(component+'-build-manifest.json');
 const relative=component==='language'?'commerce-assistant-platform/app/commerce_language_engine':'ai-service';
 for(const [name,expected] of Object.entries(manifest)){
  assert.equal(hash(readFileSync(join(out,'build',relative,name))),expected,'Build context changed: '+name);
  if(component==='python'&&(name.endsWith('.py')||name==='requirements.lock'))assert.equal(hash(readFileSync(join(root,relative,name))),expected,'Python source changed: '+name);
 }
}
const candidate=decodeReleaseBundle(readFileSync(join(out,'candidate-data/deployment-release.json.gz'))).payload;
const rollback=decodeReleaseBundle(readFileSync(join(out,'rollback-data/deployment-release.json.gz'))).payload;
assert.equal(candidate.format,2);assert.equal(rollback.format,2);
assert.equal(candidate.identity.baseReleaseId,rollback.identity.releaseId);
assert.equal(candidate.identity.runtimeSha256,await runtimeSha256());
assert.equal(candidate.identity.runtimeSha256,await runtimeSha256(pathToFileURL(join(out,'engine/'))));
assert.equal(candidate.identity.corpusSha256,hash(readFileSync(join(out,'production-corpus.jsonl'))));
assert.equal(candidate.identity.corpusSha256,rollback.identity.corpusSha256);
const node=json('full-node-tests-summary.json'),python=json('python-deployment-validation.json');
assert.equal(node.exitCode,0);assert.equal(node.counts.fail,0);assert.equal(node.counts.skipped,0);
assert.equal(hash(readFileSync(join(root,node.log))),node.logSha256);
assert.equal(python.status,'passed');assert.equal(python.sourceStability.unchanged,true);
for(const [name,expected] of Object.entries(python.logs))assert.equal(hash(readFileSync(join(out,name))),expected);
const replay=json('offline-language-replay.json'),examples=json('authored-examples.json');
assert.equal(replay.comparison.regressedTurns,0);assert.equal(examples.counts.passed,22);
const live=json('live-catalog-verified/demo-validation.json');
assert.equal(live.failed,0);assert.equal(live.totalCases,16);assert.equal(live.domainEvidenceEnabled,false);
assert.equal(live.candidateFingerprint,candidate.artifact.generationFingerprint);
assert.deepEqual([...live.stores].sort(),['electronics','grocery','jewelry','pharmacy']);
for(const [name,expected] of Object.entries(live.nodeSourceHashes))assert.equal(hash(readFileSync(join(root,'commerce-assistant-platform/app/commerce_language_engine',name))),expected,'Live-catalog Node source changed: '+name);
for(const [name,expected] of Object.entries(live.pythonSourceHashes))assert.equal(hash(readFileSync(join(root,name))),expected,'Live-catalog Python source changed: '+name);
assert.equal(hash(readFileSync(join(out,'live-catalog-verified/catalog-reads.jsonl'))),live.catalogReadsSha256);
const gate=json('initial-archived-corpus.json'),diagnostics=json('archived-diagnostics/summary.json');
assert.equal(gate.runtimeStable,true);assert.equal(gate.runtimeSha256,candidate.identity.runtimeSha256);
assert.equal(gate.count,candidate.corpus.length);assert.equal(gate.failureCount,diagnostics.failureCount);
assert.equal(gate.passed,false);assert.equal(gate.failureCount,2253);assert.equal(gate.wireFailureCount,0);
assert.deepEqual(diagnostics.classification,{preexisting_archived_expectation_failure:2253});
const rehearsal=json('release-rehearsal.json'),rejection=json('failed-gate-promotion-check.json');
assert.equal(rehearsal.candidate.releaseId,candidate.identity.releaseId);
assert.ok(rehearsal.tenants.length===4&&rehearsal.tenants.every(t=>t.sessionIsolation&&t.stagingAccessDenied&&t.unpromotedCandidateStartupDenied));
assert.equal(rejection.promotionRejected,true);assert.equal(rejection.activeBaselineUnchanged,true);
assert.equal(rejection.evaluationSourceSha256,hash(readFileSync(join(out,rejection.evaluationSource))));
const readiness=name=>readFileSync(join(out,name),'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.component==='language');
const before=readiness('production-runtime-before.jsonl'),after=readiness('production-runtime-after.jsonl');
assert.equal(after.length,4);
for(const row of after){const prior=before.find(x=>x.store===row.store);assert.ok(prior);assert.deepEqual(row.ready,prior.ready);assert.equal(row.ready.status,'ok');assert.equal(row.ready.provenance.releaseId,rollback.identity.releaseId);assert.equal(row.runtimeSha256,rollback.identity.runtimeSha256);}
const backup=json('rollback-backup.json');assert.equal(backup.baselineReleaseId,rollback.identity.releaseId);
const report={verifiedAt:new Date().toISOString(),status:'evidence_consistent_release_blocked',productionReady:false,productionActivated:false,
 candidate:candidate.identity,knowledgeRevision:candidate.artifact.languageKnowledge.revision,
 fixes:{architecture:true,publicContractGuard:true,typedContextExamples:22,unrelatedCatalogFallback:true},
 tests:{node:node.counts,python:python.fullPython,liveCatalog:{passed:live.passed,total:live.totalCases,reads:live.distinctCatalogReads},historicalRegressionTurns:replay.comparison.regressedTurns},
 archivedGate:{passed:false,count:gate.count,failures:gate.failureCount,wireFailures:gate.wireFailureCount,preexistingFailures:2253,newArchivedExpectationRegressions:0},
 rollback:{artifactsPrepared:true,privateBackup:backup.path,failedPromotionRejected:true,candidatePromotionRollbackRehearsed:false},
 production:{stores:after.map(x=>x.store),unchanged:true,revision:5,releaseId:rollback.identity.releaseId},
 preservedHistoricalFiles:Object.keys(snapshot.preserved).length,
 remaining:['Adjudicate and repair the archived release failures; preserve justified label changes in a new reviewed corpus version.','Repair the 15 replacement-arrival semantic routes; execution admission is safe but clarification meaning remains wrong.','After a passing exact evaluation, rehearse candidate promotion/rollback and coordinated all-demo publication.']};
writeFileSync(join(out,'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,productionReady:false,gateFailures:gate.failureCount,historicalFilesPreserved:report.preservedHistoricalFiles}));
