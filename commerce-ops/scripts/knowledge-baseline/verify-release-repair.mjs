/** Verify evidence for one frozen release, never the concurrently edited checkout.
 * Run only after the exact gate, rehearsal, images and Python reports finish.
 * Missing or inconsistent evidence throws before a successful report is written.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const root=resolve(import.meta.dirname,'../..');
const out=resolve(process.argv[2]??join(root,'output/enterprise-knowledge-release-repair-20261010/final'));
const repair=resolve(out,'..');
const engine=join(out,'engine');
const expectedRuntime='9f58fcc4a7394d61658310f8bcb37fbde3c3427345d876e20c4b19b1fa0a1182';
const expectedBaseline='80882336-f1a0-4cdf-bac3-1eebaccc58ea';
const stores=['electronics','grocery','jewelry','pharmacy'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const fileHash=path=>hash(readFileSync(path));
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const fromOut=name=>json(join(out,name));
const jsonl=path=>readFileSync(path,'utf8').trimEnd().split('\n').map(JSON.parse);
const assertHash=(path,expected,what=path)=>assert.equal(fileHash(path),expected,`Changed evidence: ${what}`);
const nonempty=value=>assert.ok(value&&Object.keys(value).length,'Expected a nonempty evidence collection');
const evidenceFiles=new Set();
const evidence=name=>{evidenceFiles.add(name);return fromOut(name);};

// Preflight prevents a half-finished rehearsal from looking like a passing release.
for(const name of ['rehearsal/release-rehearsal.json','rehearsal/exact-candidate-evaluation.json',
 'node-db-release-final-verification.json','python-validation/summary.json',
 'live-catalog-validation/demo-validation.json','order-admission.json','image-verification.json']){
 assert.ok(existsSync(join(out,name)),`Evidence not complete: ${name}`);
}

const snapshot=evidence('runtime-snapshot.json');nonempty(snapshot.files);nonempty(snapshot.preserved);
for(const [name,expected] of Object.entries(snapshot.files))assertHash(join(engine,name),expected,`frozen engine/${name}`);
for(const [name,expected] of Object.entries(snapshot.preserved))assertHash(join(root,name),expected,`preserved historical ${name}`);
const {runtimeSha256}=await import(pathToFileURL(join(engine,'src/runtime-identity.ts')).href);
assert.equal(await runtimeSha256(pathToFileURL(engine+'/')),expectedRuntime);
const {decodeReleaseBundle}=await import(pathToFileURL(join(engine,'scripts/deployment-release.ts')).href);
const {adjudicateCase}=await import(pathToFileURL(join(engine,'src/generation/corpus-adjudication.ts')).href);

const buildRoots={language:join(out,'build/ai-service/app/commerce_language_engine'),python:join(out,'build/ai-service')};
const manifests={};
for(const component of Object.keys(buildRoots)){
 const manifest=evidence(component+'-build-manifest.json');nonempty(manifest);manifests[component]=manifest;
 for(const [name,expected] of Object.entries(manifest))assertHash(join(buildRoots[component],name),expected,`${component} build/${name}`);
}
for(const [name,expected] of Object.entries(snapshot.files)){
 if(name==='data/compiled.json')continue; // Export adds release identity; compare its exact bytes below.
 assert.equal(manifests.language[name],expected,`Frozen/build mismatch: ${name}`);
}
assert.equal(await runtimeSha256(pathToFileURL(buildRoots.language+'/')),expectedRuntime);
const frozenNodeSource=Object.fromEntries(Object.entries(snapshot.files).filter(([name])=>name.startsWith('src/')&&name.endsWith('.ts')));
const builtPythonSource=Object.fromEntries(Object.entries(manifests.python).filter(([name])=>name.startsWith('app/')&&name.endsWith('.py')));
// The assistant image intentionally excludes Node authoring tools, retaining its compiled dictionary.
const deployedPythonSource=Object.fromEntries(Object.entries(builtPythonSource).filter(([name])=>!name.startsWith('app/commerce_language_engine/')));
const validatedPythonSource=Object.fromEntries(Object.entries(builtPythonSource).map(([name,sha])=>['commerce-assistant-platform/'+name,sha]));
nonempty(frozenNodeSource);nonempty(builtPythonSource);

const rehearsal=evidence('rehearsal/release-rehearsal.json');
const operatorInputs=evidence('operator-inputs-manifest.json');assert.equal(Object.keys(operatorInputs).length,27);
for(const [name,expected] of Object.entries(operatorInputs))assertHash(join(out,'operator-inputs',name),expected,'operator input '+name);
for(const name of Object.keys(operatorInputs).filter(name=>name.startsWith('commerce-assistant-platform/migrations/')||name.startsWith('deploy/')||name.startsWith('scripts/'))){
 assertHash(join(out,'python-source',name),operatorInputs[name],'operator/Python validation input '+name);
}
assert.equal(operatorInputs['deploy/assistant/shared-language-tenants.sql'],rehearsal.tenantPolicySha256);
assert.equal(rehearsal.status,'passed_exact_gate_promote_and_rollback_rehearsal');
assert.equal(rehearsal.runtimeSha256,expectedRuntime);
assert.equal(rehearsal.baseReleaseId,expectedBaseline);
for(const key of ['productionChanged','mainLocalDatabaseChanged','productionActivated'])assert.equal(rehearsal[key],false,key);
assert.equal(rehearsal.cleanedUp,true);assert.deepEqual(rehearsal.cleanupErrors,[]);
assert.equal(rehearsal.promotion.performed,true);assert.equal(rehearsal.rollback.performed,true);
assert.equal(rehearsal.finalActiveReleaseId,expectedBaseline);
const candidatePath=join(out,'rehearsal/candidate-data/deployment-release.json.gz');
const rollbackPath=join(out,'rehearsal/rollback-data/deployment-release.json.gz');
const candidate=decodeReleaseBundle(readFileSync(candidatePath)).payload;
const rollback=decodeReleaseBundle(readFileSync(rollbackPath)).payload;
assert.equal(candidate.format,2);assert.equal(rollback.format,2);
assert.equal(candidate.identity.baseReleaseId,rollback.identity.releaseId);assert.equal(rollback.identity.releaseId,expectedBaseline);
assert.equal(candidate.identity.runtimeSha256,expectedRuntime);assert.equal(rollback.identity.runtimeSha256,rehearsal.baseRuntimeSha256);
assert.deepEqual(candidate.identity,rehearsal.candidateExport.identity);assert.deepEqual(rollback.identity,rehearsal.rollbackExport.identity);
assertHash(candidatePath,rehearsal.candidateExport.bundleSha256);assertHash(rollbackPath,rehearsal.rollbackExport.bundleSha256);
assert.equal(candidate.artifact.languageKnowledge.revision,10);
const sourceCandidate=evidence('candidate.json');const {corpus:_sourceCorpus,...sourceContent}=sourceCandidate;
const {corpus:_exportCorpus,...exportContent}=candidate.artifact;assert.deepEqual(sourceContent,exportContent);
assertHash(join(engine,'data/compiled.json'),rehearsal.inputs.candidateFileSha256);
assertHash(join(out,'candidate.json'),rehearsal.inputs.candidateFileSha256);
assertHash(join(out,'rehearsal/candidate-data/compiled.json'),rehearsal.candidateExport.compiledSha256);
assert.equal(manifests.language['data/deployment-release.json.gz'],rehearsal.candidateExport.bundleSha256);
assert.equal(manifests.language['data/compiled.json'],rehearsal.candidateExport.compiledSha256);
assert.equal(manifests.python['app/commerce_language_engine/data/compiled.json'],rehearsal.candidateExport.compiledSha256);

const benchmark=join(repair,rehearsal.inputs.benchmarkDirectory);
assert.equal(rehearsal.inputs.benchmarkDirectory,'benchmark-v4');
const adjudication=json(join(benchmark,'benchmark-adjudication.json'));
const crossReview=json(join(benchmark,'cross-review.json'));
const reviewedPath=join(benchmark,'reviewed-corpus.jsonl');
assertHash(reviewedPath,candidate.identity.corpusSha256);
assert.equal(adjudication.corpusSha256,candidate.identity.corpusSha256);
assert.equal(crossReview.corpusSha256,candidate.identity.corpusSha256);assert.equal(crossReview.approvedForExactRegressionEvaluation,true);
assertHash(join(benchmark,'benchmark-review-samples.json'),crossReview.samplesSha256);
const originalPath=join(root,'output/enterprise-knowledge-release-prep-20261010/production-corpus.jsonl');
assertHash(originalPath,adjudication.originalSha256);assert.equal(adjudication.originalSha256,rollback.identity.corpusSha256);
const originals=jsonl(originalPath),reviewed=jsonl(reviewedPath),patches=jsonl(join(benchmark,'benchmark-patches.jsonl'));
assert.equal(originals.length,136368);assert.equal(reviewed.length,originals.length);assert.deepEqual(candidate.corpus,reviewed);
const patchMap=new Map(patches.map(row=>[row.caseIndex,row]));assert.equal(patchMap.size,patches.length);
let changed=0;
for(let index=0;index<originals.length;index++){
 const before=originals[index],after=reviewed[index],result=adjudicateCase(before);
 assert.deepEqual(after,result.next,`Semantic authoring rules differ at row ${index+1}`);
 for(const key of ['text','source','split','difficulty','templateFamily'])assert.deepEqual(after[key],before[key],`Original ${key} changed at row ${index+1}`);
 for(const [key,value] of Object.entries(before.entities??{})){
  assert.ok(Object.hasOwn(after.entities??{},key),'An entity assertion was removed');
  if(key==='productText'&&result.rules.includes('literal_question_product'))assert.equal(after.entities[key].toLowerCase(),value);
  else assert.deepEqual(after.entities[key],value,'An entity assertion changed');
 }
 const patch=patchMap.get(index);
 if(!isDeepStrictEqual(before,after)){
  changed++;assert.ok(patch,`Undocumented benchmark change at ${index+1}`);
  assert.deepEqual(patch.before,before);assert.deepEqual(patch.after,after);assert.deepEqual(patch.rules,result.rules);
  assert.equal(patch.originalSha256,hash(JSON.stringify(before)));assert.equal(patch.correctedSha256,hash(JSON.stringify(after)));
 }else assert.equal(patch,undefined,'Vacuous patch');
}
assert.equal(changed,adjudication.changedCases);assert.equal(changed,15543);assert.equal(patches.length,changed);
const failureReviews=jsonl(join(benchmark,'benchmark-review.jsonl'));
assert.equal(failureReviews.length,2253);assert.equal(new Set(failureReviews.map(row=>row.caseIndex)).size,2253);
const originalFailures=jsonl(join(root,'output/enterprise-knowledge-release-prep-20261010/archived-diagnostics/all-failures.jsonl'));
assert.deepEqual(failureReviews.map(row=>row.caseIndex).sort((a,b)=>a-b),originalFailures.map(row=>row.caseIndex).sort((a,b)=>a-b));
for(const row of failureReviews)assert.deepEqual(row.expectation,reviewed[row.caseIndex]);
assert.deepEqual(adjudication.byDisposition,{benchmark_correction:795,parser_repair_required:1458});

const gate=evidence('rehearsal/exact-candidate-evaluation.json');
assert.equal(gate.passed,true);assert.equal(gate.count,136368);assert.equal(gate.failureCount,0);assert.equal(gate.wireFailureCount,0);
assert.deepEqual(gate.failures,[]);assert.equal(gate.rubricVersion,'commerce-language-release-v1');
for(const key of ['runtimeSha256','artifactSha256','corpusSha256'])assert.equal(gate[key],candidate.identity[key]);
assert.equal(rehearsal.evaluation.evaluationId,gate.evaluationId);assert.equal(rehearsal.evaluation.exitCode,0);
assertHash(join(out,'rehearsal/exact-candidate-evaluation.json'),rehearsal.evaluation.sourceReportSha256);
assert.equal(rehearsal.gate.unchanged,true);assert.equal(rehearsal.gate.contractVersion,2);
assertHash(join(engine,'scripts/release-evaluation.ts'),fileHash(join(root,'output/production-language-contract-20261009/source/ai-service/app/commerce_language_engine/scripts/release-evaluation.ts')),'unchanged equality rubric');
assert.deepEqual(rehearsal.tenants.map(row=>row.store).sort(),stores);
for(const row of rehearsal.tenants){
 for(const key of ['knowledgeIdentity','sessionIsolation','stagingAccessDenied'])assert.equal(row[key],true,`${row.store}/${key}`);
 for(const [key,expectedSuccess] of [['inactiveCandidate',false],['initialBaseline',true],['promotedCandidate',true],['restoredBaseline',true],['staleCandidate',false]]){
  const check=row[key];assert.equal(check.verified,true);assert.equal(check.expectedSuccess,expectedSuccess);assert.equal(check.exitCode===0,expectedSuccess);
  assertHash(join(out,'rehearsal',check.log),check.logSha256);
 }
}

const replay=evidence('offline-language-replay.json');
assert.equal(replay.summary.conversations,4000);assert.equal(replay.summary.turns,4675);assert.equal(replay.rows.length,4675);
assert.equal(replay.comparison.regressedTurns,0);assert.equal(replay.comparison.regressedChecks,0);assert.equal(replay.comparison.improvedTurns,43);
assert.equal(replay.provenance.generationFingerprint,candidate.artifact.generationFingerprint);
assertHash(join(engine,'data/compiled.json'),replay.provenance.compiledSha256);
assertHash(replay.provenance.csvPath,replay.provenance.csvSha256);assertHash(replay.provenance.casesPath,replay.provenance.casesSha256);
assertHash(join(engine,'scripts/shopper-csv-evaluation.ts'),replay.provenance.rubricSha256);
const sourcePaths=[];
function collect(path){for(const entry of readdirSync(path,{withFileTypes:true})){const child=join(path,entry.name);if(entry.isDirectory())collect(child);else if(entry.name.endsWith('.ts'))sourcePaths.push(child);}}
collect(join(engine,'src'));const digest=createHash('sha256');
for(const path of sourcePaths.sort()){digest.update('/'+relative(engine,path));digest.update('\0');digest.update(readFileSync(path));digest.update('\0');}
assert.equal(digest.digest('hex'),replay.provenance.engineSourceSha256);
const admission=evidence('order-admission.json');
assert.equal(admission.total,15);assert.equal(admission.cases.length,15);assert.equal(admission.semanticPassed,15);assert.equal(admission.executionGuardPassed,15);
assert.equal(admission.candidateSha256,replay.provenance.compiledSha256);
assert.equal(admission.runtimeSha256,expectedRuntime);assert.ok(Date.parse(admission.checkedAt)>=Date.parse(snapshot.createdAt));
assertHash(join(root,'scripts/knowledge-baseline/release-demo-order-admission.py'),admission.harnessSha256);
assert.deepEqual(admission.nodeSourceHashes,frozenNodeSource);assert.deepEqual(admission.pythonSourceHashes,validatedPythonSource);
for(const [name,expected] of Object.entries(admission.nodeSourceHashes))assertHash(join(engine,name),expected,'order admission frozen Node '+name);
for(const [name,expected] of Object.entries(admission.pythonSourceHashes)){
 assertHash(join(out,'python-source',name),expected,'order admission frozen Python '+name);
 assertHash(join(out,'build',name),expected,'order admission built Python '+name);
}
for(const row of admission.cases){assert.equal(row.semanticPass,true);assert.equal(row.executionGuardPass,true);assert.equal(row.candidateIntent,'DELIVERY_DATE');assert.equal(row.candidateStatus,'NEEDS_CONTEXT');assert.equal(row.route,'clarify');assert.equal(row.modelCalls,0);assert.deepEqual(row.commerceCalls,[]);}

const live=evidence('live-catalog-validation/demo-validation.json');
assert.equal(live.totalCases,16);assert.equal(live.passed,16);assert.equal(live.failed,0);assert.equal(live.cases.length,16);
assert.deepEqual([...live.stores].sort(),stores);assert.equal(live.domainEvidenceEnabled,false);
assert.equal(live.candidateFingerprint,candidate.artifact.generationFingerprint);assert.equal(live.candidateSha256,replay.provenance.compiledSha256);
assertHash(join(root,'scripts/knowledge-baseline/release-demo-validation.py'),live.harnessSha256);
assert.ok(Date.parse(live.checkedAt)>=Date.parse(snapshot.createdAt));
assert.deepEqual(live.nodeSourceHashes,frozenNodeSource);assert.deepEqual(live.pythonSourceHashes,validatedPythonSource);
for(const [name,expected] of Object.entries(live.nodeSourceHashes))assertHash(join(engine,name),expected,'live-catalog frozen Node '+name);
for(const [name,expected] of Object.entries(live.pythonSourceHashes)){
 assertHash(join(out,'python-source',name),expected,'live-catalog frozen Python '+name);
 assertHash(join(out,'build',name),expected,'live-catalog built Python '+name);
}
const readsPath=join(out,'live-catalog-validation/catalog-reads.jsonl');assertHash(readsPath,live.catalogReadsSha256);
const reads=jsonl(readsPath);assert.equal(reads.length,live.distinctCatalogReads);assert.equal(reads.length,15);
assert.deepEqual([...new Set(reads.map(row=>row.store))].sort(),stores);
for(const row of reads){assert.equal(row.httpStatus,200);assert.ok(['get_catalog_schema','search_products','get_product'].includes(row.request.name));assert.ok(Date.parse(row.capturedAt)>=Date.parse(snapshot.createdAt),'Fresh catalog capture predates final freeze');}
for(const row of live.cases){assert.equal(row.pass,true);assert.ok(Object.values(row.checks).every(value=>value===true));assert.equal(row.answer.modelCalls,0);}

const node=evidence('node-db-release-final-verification.json');
assert.equal(node.exitCode,0);assert.equal(node.tests,783);assert.equal(node.passed,783);assert.equal(node.failed,0);assert.equal(node.skipped,0);
assert.equal(node.databaseFixturesEnabled,true);assert.equal(node.sourceUnchanged,true);assert.equal(node.runtimeSha256,expectedRuntime);assert.equal(node.runtimeAfter,expectedRuntime);
assert.equal(await runtimeSha256(pathToFileURL(node.engineRoot+'/')),expectedRuntime);
const nodeLog=readFileSync(join(out,node.log),'utf8');
evidenceFiles.add(node.log);
for(const [key,value] of [['tests',783],['pass',783],['fail',0],['skipped',0]])assert.match(nodeLog,new RegExp(`\\b${key}\\s+${value}\\s*$`,'m'));
const nodeInputs=evidence('node-test-final-input-manifest.json');
for(const row of nodeInputs.files)assertHash(join(out,'node-test-workspace',row.path),row.sha256,'Node test input '+row.path);
assert.ok(nodeInputs.files.some(row=>row.path.endsWith('/tests/release-envelope-regression.test.ts')));

const python=evidence('python-validation/summary.json');
assert.equal(python.passed,true,'Python validation is incomplete or failed; no release verification can be emitted');assert.equal(python.error,null);assert.equal(python.productionChanged,false);
assert.equal(python.frozenRuntimeSha256,expectedRuntime);assert.equal(python.frozenRuntimeUnchanged,true);
assert.equal(python.dictionarySha256,replay.provenance.compiledSha256);assert.equal(python.dictionaryUnchanged,true);
assert.equal(python.generationFingerprint,candidate.artifact.generationFingerprint);assert.equal(python.sourceUnchanged,true);assert.deepEqual(python.changedSourceFiles,[]);
assert.equal(python.databaseFixturesEnabled,true);assert.equal(python.localNodeHttpEnabled,true);assert.equal(python.disposableContainerRemoved,true);
const before=evidence('python-validation/source-before.json'),after=evidence('python-validation/source-after.json');assert.deepEqual(after,before);
nonempty(before);
for(const [name,expected] of Object.entries(before))assertHash(join(out,'python-source',name),expected,'Python validation input '+name);
const completePythonInputs=evidence('python-source-snapshot-complete.json');
nonempty(completePythonInputs.sourceManifest);
for(const [name,expected] of Object.entries(completePythonInputs.sourceManifest))assertHash(join(out,'python-source',name),expected,'Complete isolated Python input '+name);
const typedCorrection=evidence('typed-exclusion-benchmark-and-runtime-repair-final.json');
assert.equal(typedCorrection.version,3);assert.equal(typedCorrection.passed,true);
assert.equal(typedCorrection.oldFixtureUnchanged,true);assert.equal(typedCorrection.runtimeChanged,true);assert.equal(typedCorrection.nodeRuntimeChanged,false);assert.equal(typedCorrection.artifactChanged,false);
assert.equal(typedCorrection.frozenRuntimeSha256,expectedRuntime);assert.equal(typedCorrection.dictionarySha256,replay.provenance.compiledSha256);
assertHash(join(out,'python-source',typedCorrection.originalFixture),typedCorrection.originalFixtureSha256);
assert.deepEqual(typedCorrection.caseIds,['exclusions-17','exclusions-32']);
for(const [name,expected] of Object.entries(typedCorrection.newFileHashes))assertHash(join(out,'python-source',name),expected,'Typed exclusion fixture '+name);
assert.equal(Object.keys(typedCorrection.pythonSourceChanges).length,2);
for(const [name,change] of Object.entries(typedCorrection.pythonSourceChanges)){
 assertHash(join(out,'python-runtime-before-exclusions',name),change.before,'Preserved Python source before exclusion fix '+name);
 assertHash(join(out,'python-source',name),change.after,'Fixed Python exclusion source '+name);
 assert.equal(validatedPythonSource[name],change.after);assert.notEqual(change.before,change.after);
}
assertHash(join(out,typedCorrection.historicalOverlayReport.path),typedCorrection.historicalOverlayReport.sha256);
evidenceFiles.add(typedCorrection.historicalOverlayReport.path);
assert.equal(typedCorrection.targetedValidation.passed,54);assert.equal(typedCorrection.targetedValidation.failed,0);
assertHash(join(out,typedCorrection.targetedValidation.log),typedCorrection.targetedValidation.logSha256);
assert.match(readFileSync(join(out,typedCorrection.targetedValidation.log),'utf8'),/\b54 passed\b/);
assert.equal(typedCorrection.typecheck.passed,true);assert.equal(typedCorrection.typecheck.sourceFiles,255);
assertHash(join(out,typedCorrection.typecheck.log),typedCorrection.typecheck.logSha256);
assert.equal(typedCorrection.review.humanPerCaseReview,false);
const typedFixtures=json(join(out,'python-source/ai-service/tests/fixtures/enterprise_contracts/typed-material-exclusions-v2.json'));
assertHash(join(out,'python-source/ai-service',typedFixtures.sourceFixture),typedFixtures.sourceSha256);
assert.equal(typedFixtures.review.humanPerCaseReview,false);assert.equal(typedFixtures.cases.length,2);
for(const row of typedFixtures.cases){
 for(const [kind,collection] of [['concept','concepts'],['rule','rules']])assert.ok(candidate.artifact.languageKnowledge[collection].some(value=>Object.entries(row.requiresKnowledge[kind]).every(([key,expected])=>isDeepStrictEqual(value[key],expected))));
 assert.equal(row.expected.relation.negated,true);assert.equal(row.expected.relation.relation,'material');
}
const materialProof=evidence('typed-material-retrieval-proof.json');
assert.equal(typedCorrection.actualWorkflowProof.path,'typed-material-retrieval-proof.json');
assertHash(join(out,typedCorrection.actualWorkflowProof.path),typedCorrection.actualWorkflowProof.sha256);
assert.equal(typedCorrection.actualWorkflowProof.passed,4);assert.equal(typedCorrection.actualWorkflowProof.failed,0);
assert.equal(materialProof.passed,true);assert.equal(materialProof.runtimeSha256,expectedRuntime);
assert.equal(materialProof.dictionarySha256,replay.provenance.compiledSha256);
assertHash(join(out,'typed-material-retrieval-proof.py'),materialProof.verifierSha256);
assert.deepEqual(materialProof.pythonSourceSha256,builtPythonSource);
assert.ok(Date.parse(materialProof.checkedAt)>=Date.parse(snapshot.createdAt));
nonempty(materialProof.fixtureSourceSha256);
for(const [name,expected] of Object.entries(materialProof.fixtureSourceSha256))assertHash(join(out,'python-source/ai-service',name),expected,'Actual exclusion proof fixture '+name);
assert.equal(materialProof.cases.length,4);
for(const [message,excluded] of [['find bags excluding leather','leather'],['find gloves without latex','latex']]){
 const cases=materialProof.cases.filter(row=>row.message===message);
 assert.deepEqual(cases.map(row=>row.supportedSchema).sort(),[false,true]);
 for(const row of cases){
  assert.equal(row.passed,true);assert.equal(row.zeroModelTokens,true);
  assert.deepEqual(row.returnedRoutes,row.expectedRoutes);
  assert.equal(row.searchCalls,row.supportedSchema?1:0);assert.equal(row.catalogReads,row.supportedSchema?1:0);
  assert.deepEqual(row.predicates,row.supportedSchema?[{name:'material',operator:'neq',value:excluded}]:[]);
  assert.deepEqual(row.expectedRoutes,row.supportedSchema?['/products/00000000-0000-0000-0000-00000000000c']:[]);
 }
}
const checks=new Map(python.checks.map(row=>[row.name,row]));assert.equal(checks.size,5);
for(const name of ['architecture','capabilities','deployment-guards','shared-database-isolation','python-full-postgres-http'])assert.ok(checks.has(name),'Missing Python check: '+name);
for(const check of python.checks){
 const log=check.log??check.name+'.log';assertHash(join(out,'python-validation',log),check.logSha256,'Python check '+check.name);
 assert.equal(check.exitCode,0,'Python check failed: '+check.name);
}
const full=checks.get('python-full-postgres-http');
assert.equal(full.passed,4776);assert.equal(full.failed??0,0);assert.equal(full.skipped,1);
const pythonLog=readFileSync(join(out,'python-validation',full.log??full.name+'.log'),'utf8');
assert.match(pythonLog,new RegExp(`\\b${full.passed} passed\\b`));assert.match(pythonLog,/\b1 skipped\b/);
assert.deepEqual(full.skipReasons,['SKIPPED [1] tests/test_baskets_live.py:18: Explicit isolated live basket-provider configuration is absent']);
const capabilities=evidence('python-capabilities-review.json');assert.equal(capabilities.baseline_count,181);assert.equal(capabilities.inventory_unchanged,true);assert.equal(capabilities.exposure_metadata_unchanged,true);assert.deepEqual(capabilities.changed_fields,[]);
const fixedCapabilities=evidence('python-capabilities-exclusion-review.json');
assert.equal(fixedCapabilities.baseline_count,181);assert.equal(fixedCapabilities.inventory_unchanged,true);assert.equal(fixedCapabilities.exposure_metadata_unchanged,true);
assert.deepEqual(fixedCapabilities.changed_fields,['source_sha256']);assert.deepEqual(fixedCapabilities.changed_sources.sort(),Object.keys(typedCorrection.pythonSourceChanges).sort());

const backup=json(join(repair,'backup-restore-rehearsal.json')),cleanup=json(join(repair,'backup-restore-cleanup-verification.json'));
assert.equal(backup.status,'passed_same_host_production_backup_full_restore');assert.equal(backup.backupFilesUnchanged,true);assert.equal(backup.backupPayloadExported,false);
assert.equal(backup.productionDatabasesChanged,false);assert.equal(backup.productionContainersChanged,false);
assert.equal(backup.containerRemoved,true);assert.equal(backup.volumeRemoved,true);assert.deepEqual(backup.cleanupErrors,[]);
assert.equal(cleanup.cleanupVerified,true);assert.deepEqual(cleanup.ownedDrillResourcesRemaining,{containers:0,volumes:0});
assert.equal(backup.baselineIdentity.releaseId,rollback.identity.releaseId);assert.equal(backup.baselineIdentity.artifactSha256,rollback.identity.artifactSha256);assert.equal(backup.baselineIdentity.corpusSha256,rollback.identity.corpusSha256);
assert.equal(backup.baselineIdentity.artifactHashVerified,true);assert.equal(backup.baselineIdentity.corpusHashVerified,true);assert.equal(backup.baselineIdentity.corpusCases,136368);
let tables=0,constraints=0;
assert.deepEqual(Object.keys(backup.databases).sort(),['assistant','commerce_language']);
for(const database of Object.values(backup.databases)){
 assert.equal(database.restoreExitCode,0);assert.equal(database.archivedTableCountsMatch,true);assert.equal(database.capturedHashVerified,true);
 assert.equal(database.tableCount,Object.keys(database.tableRowCounts).length);tables+=database.tableCount;
 assert.equal(database.integrity.invalidIndexes,0);assert.equal(database.integrity.unvalidatedConstraints,0);constraints+=database.integrity.constraints;
}
assert.equal(tables,67);assert.equal(constraints,304);

const images=evidence('image-verification.json');assert.equal(images.passed,true);assert.deepEqual(Object.keys(images.images).sort(),['assistant','language']);
for(const [name,image] of Object.entries(images.images)){
 assert.match(image.imageId,/^sha256:[a-f0-9]{64}$/);assert.equal(image.network,'none');assert.equal(image.readOnly,true);
 assert.ok(image.nonRootUser&&image.nonRootUser!=='0'&&image.nonRootUser!=='root');assert.ok(image.result.uid>0);assert.equal(image.result.passed,true);
 assertHash(join(out,name+'-image-runtime.log'),image.logSha256);
}
assert.deepEqual(images.images.language.result.identity,candidate.identity);assert.equal(images.images.language.result.checks,6);
assert.equal(images.images.assistant.result.knowledgeRevision,10);assert.equal(images.images.assistant.result.fingerprint,candidate.artifact.generationFingerprint);assert.equal(images.images.assistant.result.publishedRulesReadable,true);
assert.deepEqual(images.images.assistant.result.sourceSha256,deployedPythonSource);
assert.equal(images.images.assistant.result.compiledSha256,rehearsal.candidateExport.compiledSha256);
const imageScope=evidence('image-source-scope-review.json');
assert.equal(imageScope.runtimeChanged,false);assert.equal(imageScope.actualPythonAppFileMismatches,0);
assert.deepEqual(Object.keys(builtPythonSource).filter(name=>!Object.hasOwn(deployedPythonSource,name)),[imageScope.absentFile]);

const performance=evidence('performance-comparison.json');
assert.equal(performance.status,'latency_investigation_complete_measured_slowdown_retained');
assert.equal(performance.candidateIdentity.runtimeSha256,expectedRuntime);assert.equal(performance.candidateIdentity.fingerprint,candidate.artifact.generationFingerprint);
assert.equal(performance.baselineIdentity.runtimeSha256,rollback.identity.runtimeSha256);assert.equal(performance.baselineIdentity.fingerprint,rollback.artifact.generationFingerprint);
assert.equal(performance.candidateIdentity.csvSha256,replay.provenance.csvSha256);assert.equal(performance.baselineIdentity.csvSha256,replay.provenance.csvSha256);
assert.equal(performance.method.frozenRuntimeModified,false);assert.equal(performance.method.historicalReportsOverwritten,false);
assert.equal(performance.threshold.investigationComplete,true);assert.equal(performance.threshold.p95Crossed,true);
assert.equal(Object.keys(performance.evidenceSha256).length,13);
for(const [name,expected] of Object.entries(performance.evidenceSha256))assertHash(join(root,name),expected,'performance evidence '+name);
for(const value of Object.values(performance.pairedMetrics))assert.ok(Math.abs(((value.candidate/value.baseline)-1)*100-value.changePercent)<1e-9,'Performance delta does not match measurements');

const productionBefore=jsonl(join(repair,'production-runtime-before.jsonl')).filter(row=>row.component==='language');
const productionAfter=jsonl(join(out,'production-runtime-after.jsonl')).filter(row=>row.component==='language');
assert.deepEqual(productionBefore.map(row=>row.store).sort(),stores);assert.deepEqual(productionAfter.map(row=>row.store).sort(),stores);
assert.equal(rollback.artifact.languageKnowledge.revision,5);
for(const row of productionAfter){
 const prior=productionBefore.find(value=>value.store===row.store);assert.deepEqual(row.ready,prior.ready);
 assert.equal(row.ready.status,'ok');assert.equal(row.ready.provenance.releaseId,rollback.identity.releaseId);assert.equal(row.runtimeSha256,rollback.identity.runtimeSha256);
 assert.equal(row.ready.generationFingerprint,rollback.artifact.generationFingerprint);assert.equal(row.ready.provenance.generationFingerprint,rollback.artifact.generationFingerprint);assert.equal(row.ready.provenance.runtimeVersion,rollback.identity.runtimeSha256);
}
evidenceFiles.add('production-runtime-after.jsonl');
for(const name of ['../backup-restore-rehearsal.json','../backup-restore-cleanup-verification.json','../production-runtime-before.jsonl',
 '../benchmark-v4/benchmark-adjudication.json','../benchmark-v4/cross-review.json','../benchmark-v4/benchmark-review-samples.json',
 '../benchmark-v4/benchmark-review.jsonl','../benchmark-v4/benchmark-patches.jsonl','../benchmark-v4/reviewed-corpus.jsonl'])evidenceFiles.add(name);

const report={verifiedAt:new Date().toISOString(),status:'frozen_release_evidence_verified',scope:'Only the frozen release runtime, candidate artifact, reviewed corpus, build inputs and recorded image checks.',
 verifierSha256:fileHash(import.meta.filename),
 currentWorkspaceUnverified:true,currentWorkspaceNotCertifiedByThisReport:true,productionActivatedByThisPreparation:false,combinedWorkspacePublicationVerified:false,
 candidate:candidate.identity,knowledgeRevision:10,
 pythonRuntime:{validatedSourceFiles:Object.keys(builtPythonSource).length,deployedSourceFiles:Object.keys(deployedPythonSource).length,sourceManifestSha256:hash(JSON.stringify(deployedPythonSource)),imageId:images.images.assistant.imageId},
 archivedGate:{passed:true,cases:136368,failures:0,wireFailures:0,originalFailures:2253,parserRepairs:1458,benchmarkCorrectionsAmongOriginalFailures:795,allCorpusCasesRetained:true,changedFixtures:15543,reviewKind:adjudication.reviewKind},
 tests:{node:{passed:783,failed:0,skipped:0},python:{passed:full.passed,failed:0,skipped:1},historical:{turns:4675,improved:43,regressed:0,passingTurns:replay.summary.passed},orderAdmission:{semanticPassed:15,executionGuardPassed:15},liveCatalog:{passed:16,total:16,reads:15,stores,domainEvidenceEnabled:false},materialExclusionWorkflow:{passed:4,targetedTests:54,unverifiedProductEvidenceRejected:true}},
 rollback:{promotionAndRollbackRehearsed:true,allFourTenantsVerified:true,disposableDatabaseRemoved:true,fullBackupRestorePassed:true,tableCountsVerified:67,constraintsValidated:304,drillResourcesRemoved:true,baseline:rollback.identity},
 images:Object.fromEntries(Object.entries(images.images).map(([name,value])=>[name,{imageId:value.imageId,platform:value.platform}])),
 performance:{status:performance.status,investigationComplete:true,p95InvestigationThresholdCrossed:true,pairedP95Ms:performance.pairedMetrics.p95Ms,pairedPeakRssKiB:performance.pairedMetrics.maxRssKiB,productionSlaEstablished:false},
 production:{historicalCapture:true,captureFile:'production-runtime-after.jsonl',currentProductionStateNotCertified:true,languageReadinessHealthyAtCapture:true,stores,baselineReleaseUnchangedAtCapture:true,releaseId:rollback.identity.releaseId,knowledgeRevision:5,fingerprint:rollback.artifact.generationFingerprint,runtimeSha256:rollback.identity.runtimeSha256},
 preservedHistoricalFiles:Object.keys(snapshot.preserved).length,
 evidenceHashes:Object.fromEntries([...evidenceFiles].sort().map(name=>[name,fileHash(join(out,name))])),
 limitations:['Current workspace includes a separate recognition-rule refactor and is not covered by this frozen-release result.','Synthetic regression and authored live-catalog checks are not customer-wide accuracy measurements.','Publication must use these verified immutable artifacts or reevaluate the combined checkout.','A separately authorized chat may activate a later release; this preparation and its historical production capture do not certify current production state.']};
writeFileSync(join(out,'verification.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,runtimeSha256:expectedRuntime,gateCases:136368,nodeTests:783,currentWorkspaceUnverified:true,productionActivatedByThisPreparation:false}));
