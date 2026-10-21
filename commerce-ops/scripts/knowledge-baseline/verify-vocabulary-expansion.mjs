import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalKnowledge,knowledgeHash} from '../../commerce-assistant-platform/app/commerce_language_engine/src/language-knowledge.ts';
import {parseBulkManifest,decodeChunk} from '../../commerce-assistant-platform/app/commerce_language_engine/src/knowledge-bulk.ts';
const root=resolve(import.meta.dirname,'../..'),out=join(root,'output/enterprise-knowledge-expansion-20261010');
const read=p=>JSON.parse(readFileSync(p)),hash=b=>createHash('sha256').update(b).digest('hex');
const snapshot=read(join(out,'snapshot-manifest.json'));
for(const [path,digest] of Object.entries(snapshot.files)){
 assert.equal(hash(readFileSync(join(out,'engine',path))),digest,path);
 if(path!=='data/compiled.json')assert.equal(hash(readFileSync(join(root,'commerce-assistant-platform/app/commerce_language_engine',path))),digest,path);
}
for(const [path,digest] of Object.entries({...snapshot.sources,...snapshot.preserved}))assert.equal(hash(readFileSync(join(root,path))),digest,path);
const manifest=parseBulkManifest(read(join(out,'bundle/manifest.json'))),concepts=manifest.chunks.flatMap(ch=>decodeChunk(readFileSync(join(out,'bundle',ch.file)),ch));
const pack=canonicalKnowledge({...manifest.header,concepts});assert.equal(knowledgeHash(pack),manifest.packSha256);
const candidate=read(join(out,'candidate.json')),vocabulary=read(join(out,'vocabulary-report.json')),stage=read(join(out,'local-stage.json'));
assert.equal(knowledgeHash(candidate.languageKnowledge),manifest.packSha256);assert.equal(vocabulary.packSha256,manifest.packSha256);
assert.equal(stage.counts.concepts,pack.concepts.length);assert.equal(stage.counts.forms,pack.concepts.reduce((n,c)=>n+1+c.aliases.length,0));
assert.equal(stage.candidateFingerprint,candidate.generationFingerprint);assert.equal(stage.activated,false);assert.equal(stage.active.revision,5);
assert.equal(stage.firstUpload.completedChunks,2);assert.equal(stage.firstUpload.completedConcepts,500);assert.equal(stage.resumed.missingChunks.length,0);assert.ok(stage.repeatReusesCandidate);
assert.equal(hash(readFileSync(join(out,'sources/wn3.1.dict.tar.gz'))),vocabulary.source.archiveSha256);assert.equal(hash(readFileSync(join(out,'sources/data.noun'))),vocabulary.source.nounSha256);
assert.equal(hash(readFileSync(join(root,'commerce-assistant-platform/app/commerce_language_engine/data/knowledge/shopping-en-phase2-v3.json'))),vocabulary.fileSha256);
const replay=read(join(out,'offline-language-replay.json'));assert.equal(replay.summary.conversations,4000);assert.equal(replay.comparison.regressedTurns,0);assert.equal(replay.comparison.regressedChecks,0);
assert.equal(replay.provenance.compiledSha256,hash(readFileSync(join(out,'candidate.json'))));
const log=p=>readFileSync(join(out,p),'utf8');
for(const file of ['node-tests.log','final-targeted-tests.log']){assert.match(log(file),/fail 0/);assert.match(log(file),/skipped 0/);}
const python=log('python-boundary-tests.log');assert.match(python,/13 passed/);assert.ok(!python.includes('FAILED'));
assert.ok(!log('typecheck.log').includes('error TS'));assert.match(log('documentation.log'),/no missing targets/);
const before=read(join(out,'baseline-performance/local-performance.json')),after=read(join(out,'local-performance.json')),examples=read(join(out,'authored-examples.json'));
const result={scope:'First English vocabulary expansion batch and resumable local staging; full Phase 2 targets and production gates remain open',checksPassed:true,productionReady:false,activated:false,revision:pack.revision,packSha256:manifest.packSha256,candidateFingerprint:candidate.generationFingerprint,counts:vocabulary.candidate,sourceReview:'AI-assisted extraction-policy and sampled review, not independent per-entry human review',sourceSha256:snapshot.sources,pythonBoundaryTestSha256:hash(readFileSync(join(root,'commerce-assistant-platform/tests/test_vocabulary_expansion.py'))),preservedArtifacts:Object.keys(snapshot.preserved).length,phase0ReservedExecuted:false,tests:{fullNode:750,finalTargetedNode:47,pythonBoundary:13,deployment:{passed:16,subtests:12,skipped:8,skipReason:'Separate disposable assistant merge container not configured; language runtime privileges tested in PostgreSQL'}},offlineReplay:{conversations:4000,turns:4675,regressions:0,gains:0},authoredExamples:examples.counts,performance:{baselineP95Ms:before.latency.p95Ms,candidateP95Ms:after.latency.p95Ms,p95ChangePercent:100*(after.latency.p95Ms/before.latency.p95Ms-1),baselinePeakRssKiB:before.memory.processMaxRssKiB,candidatePeakRssKiB:after.memory.processMaxRssKiB},storage:{prettyPackBytes:vocabulary.bytes,conceptUploadBytes:manifest.chunks.reduce((n,c)=>n+c.bytes,0),...stage.sizes},remaining:['10,000–25,000 concepts and 100,000–250,000 forms target not met','Two authored examples still use legacy catalogPurpose instead of typed shoppingContext','Generic gift/product requests are excluded from contextual relationship extraction','Exact product annotations do not repair every legacy entity/category match','Independent review and live catalog answer validation remain open','Existing tracking-contract and routing architecture release blockers remain open','Large partitions, selective loading and million-scenario evaluation are future work']};
writeFileSync(join(out,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({checksPassed:result.checksPassed,productionReady:false,counts:result.counts,authoredExamples:result.authoredExamples,performance:result.performance}));
