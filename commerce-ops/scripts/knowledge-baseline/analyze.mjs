import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {sha256,count,percentile,parseJsonSequence,classifyHistorical,classifyCurrent,familySplit,validateBenchmarkApproval} from './lib.mjs';

const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const out=resolve(process.argv[2]??join(root,'output/enterprise-knowledge-phase0-20261010'));
const read=name=>JSON.parse(readFileSync(join(out,name)));
const save=(name,data)=>writeFileSync(join(out,name),JSON.stringify(data,null,2)+'\n');
const manifest=read('snapshot-manifest.json');
for(const [name,digest] of Object.entries(manifest.engineFiles))if(sha256(readFileSync(join(out,'engine',name)))!==digest)throw new Error('Frozen engine changed: '+name);
for(const s of manifest.sources)if(sha256(readFileSync(join(root,s.path)))!==s.sha256)throw new Error('Source changed: '+s.path);
const {parseCsv,selectCases}=await import(pathToFileURL(join(out,'engine/scripts/shopper-csv-evaluation.ts')));
const csv=parseCsv(readFileSync(join(root,manifest.sources[0].path),'utf8'));
const cases=selectCases(csv,JSON.parse(readFileSync(join(root,manifest.sources[1].path))));
const replay=read('offline-language-replay.json');
if(replay.provenance.csvSha256!==manifest.sources[0].sha256||replay.provenance.casesSha256!==manifest.sources[1].sha256)throw new Error('Replay source mismatch');
if(replay.provenance.compiledSha256!==manifest.engineFiles['data/compiled.json']||replay.provenance.rubricSha256!==manifest.engineFiles['scripts/shopper-csv-evaluation.ts'])throw new Error('Replay engine/rubric mismatch');
if(csv.length!==4000||replay.rows.length!==4675)throw new Error('Unexpected corpus membership');
const byCase=new Map(),seenTurns=new Set();for(const turn of replay.rows){
 const key=turn.caseId+':'+turn.turn;if(seenTurns.has(key))throw new Error('Duplicate replay turn '+key);seenTurns.add(key);
 if(turn.passed!==turn.checks.every(c=>c.passed))throw new Error('Inconsistent replay grade '+key);
 const rows=byCase.get(turn.caseId)??[];rows.push(turn);byCase.set(turn.caseId,rows);
}
const classified=csv.map((row,index)=>{
 const turns=byCase.get(row.case_id);if(!turns||turns.length!==cases[index].turns.length)throw new Error('Missing replay turn');
 for(const t of turns)if(t.text!==cases[index].turns[t.turn-1]||t.store!==row.demo)throw new Error('Replay conversation mismatch: '+row.case_id);
 return {caseId:row.case_id,store:row.demo,familyId:row.family_id,scenarioFamily:row.scenario_family,originalGrade:row.quality_rating,originalReason:row.assessment_reason,
 historical:classifyHistorical(row),currentLanguage:{passed:turns.every(t=>t.passed),failureCategories:[...new Set(turns.flatMap(classifyCurrent))],failedChecks:turns.flatMap(t=>t.failures.map(f=>({turn:t.turn,...f})))},
 futureRegressionSplit:familySplit(row.scenario_family),humanReviewed:false};
});
save('case-classification.json',{schemaVersion:1,method:'Automated, auditable provisional classification; original CSV grades unchanged. New language checks are separate from historical response grades.',csvSha256:manifest.sources[0].sha256,rubric:replay.provenance,rows:classified});
const families=count(csv.map(r=>r.scenario_family));
const split=Object.fromEntries(['development_regression','reserved_regression'].map(name=>[name,{families:Object.keys(families).filter(f=>familySplit(f)===name),caseIds:classified.filter(r=>r.futureRegressionSplit===name).map(r=>r.caseId)}]));
save('regression-split.json',{seed:'enterprise-phase0-split-v1',unit:'scenario_family across all stores; entire conversations retained',independentHeldOut:false,reason:'All 4000 cases are previously exposed development material. Reservation only controls future use; it cannot erase earlier exposure.',splits:split});
const inventory=parseJsonSequence(readFileSync(join(out,'production-inventory.raw.json'),'utf8'));
const parts=inventory.filter(x=>!Array.isArray(x));const get=kind=>parts.find(x=>x.kind===kind)?.rows;
const plans=inventory.flatMap((x,i)=>x.kind==='queryPlan'?[{name:x.name,plan:inventory[i+1]}]:[]);
if(plans.length!==3||plans.some(p=>p.plan?.[0]?.Plan?.['Actual Rows']!==1))throw new Error('Representative query plans did not find their expected row');
save('production-inventory.json',{records:parts.filter(x=>x.kind!=='queryPlan'),queryPlans:plans});
const artifact=read('engine/data/compiled.json'),production=read('production-active-artifact.json');
// The deployment export adds an empty evaluation corpus; it is not runtime knowledge.
const normalizeArtifact=x=>({...x,corpus:x.corpus??[]});
if(!isDeepStrictEqual(normalizeArtifact(artifact),normalizeArtifact(production)))throw new Error('Local runtime artifact differs from active production artifact');
const runtime=readFileSync(join(out,'production-runtime.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const {runtimeSha256}=await import(pathToFileURL(join(out,'engine/src/runtime-identity.ts')));
const localRuntime=await runtimeSha256(pathToFileURL(join(out,'engine')+'/'));
const runtimeMatches=runtime.filter(r=>r.component==='language').map(r=>({store:r.store,ready:r.ready.status==='ok',runtimeMatches:r.runtimeSha256===localRuntime,artifactMatches:r.artifactFingerprint===artifact.generationFingerprint}));
const k=artifact.languageKnowledge;
for(const migration of get('migration'))if(manifest.engineFiles['migrations/'+migration.filename]!==migration.sha256)throw new Error('Migration checksum mismatch: '+migration.filename);
const data={activeRelease:get('activeRelease'),artifactMatchesProduction:true,rawArtifactExactlyEqual:isDeepStrictEqual(artifact,production),artifactNormalization:'Only an omitted corpus versus an empty corpus array is normalized. All other fields must match exactly.',localRuntimeSha256:localRuntime,runtimeMatches,
 counts:{published:{intents:artifact.intents.length,semanticGroups:artifact.groups.length,entityForms:artifact.entity_terms.length,concepts:k.concepts.length,vocabularyForms:k.concepts.reduce((n,c)=>n+1+c.aliases.length,0),relationshipRules:k.rules.length,utteranceFamilies:k.utteranceRules.length,utterancePhrases:k.utteranceRules.reduce((n,u)=>n+u.phrases.length,0),questionFamilies:k.questionRules.length,questionTemplates:k.questionRules.reduce((n,q)=>n+q.templates.length,0)},normalizedAuthoring:get('counts')},
 migrations:get('migration'),databaseSizes:get('databaseSizes'),knowledgePacks:get('knowledgePacks'),reviewedDatasets:get('reviewedDatasets'),
 caveat:'Normalized authoring rows are not assumed to be the active runtime. The published artifact and executable identity are checked separately.'};
save('release-inventory.json',data);
const histogram=count(classified.flatMap(r=>r.historical.categories));
const originalGrades=count(csv.map(r=>r.quality_rating));
const summary={createdAt:new Date().toISOString(),sources:manifest.sources,original:{cases:csv.length,turns:cases.reduce((n,c)=>n+c.turns.length,0),grades:originalGrades,byStore:count(csv.map(r=>r.demo)),families:families,provisionalHistoricalCategories:histogram,categoryCountsOverlap:true,missingEvidenceSignals:classified.filter(r=>r.historical.missingEvidenceSignal).length,latency:{unit:'milliseconds per conversation, historical HTTP observations; not comparable to local parser-only timings',p50:percentile(csv.map(r=>Number(r.total_response_ms)),.5),p95:percentile(csv.map(r=>Number(r.total_response_ms)),.95),p99:percentile(csv.map(r=>Number(r.total_response_ms)),.99)}},
 currentLanguage:{...replay.summary,byStore:replay.byStore,checks:replay.checks,provenance:replay.provenance,scope:replay.methodology.scope},
 limitations:['No new live shopper requests or actions.','Original ratings are automated/model-reviewed historical response assessments, not independent human labels.','Historical root cause cannot be proven from a response pattern alone.','Missing evidence, true unsupported capabilities, and evaluation errors require per-case adjudication; counts are not fabricated.','Current offline evaluation covers minimum language semantics only.','Full catalog coverage and source timestamps were not proven by the historical snapshots; hash identity does not establish completeness.'],
 progress:{inventory:runtimeMatches.every(x=>x.runtimeMatches&&x.artifactMatches&&x.ready)?'complete':'runtime_difference_requires_review',offlineReview:'complete_automated',failureClassification:'complete_provisional',humanReviewedBenchmark:'pending_human_review',independentHeldOut:'candidate_only'}};
if(existsSync(join(out,'benchmark-approved.json'))){
 const approved=read('benchmark-approved.json'),proposalBytes=readFileSync(join(out,'benchmark-candidate.json'));
 validateBenchmarkApproval(approved,JSON.parse(proposalBytes),sha256(proposalBytes));
 summary.progress.benchmarkApproval='complete_owner_approved_after_ai_review';
 summary.progress.humanReviewedBenchmark='owner_approved_with_delegated_ai_assessment; independent human adjudication not claimed';
 summary.progress.independentHeldOut='16 family-disjoint reserved cases, unexecuted; independent authorship/generalization not certified';
 summary.progress.phase0='complete_under_owner_authorized_review_method';
}
save('baseline-summary.json',summary);
console.log(JSON.stringify({original:originalGrades,currentLanguage:replay.summary,release:data.activeRelease,runtimeMatches,publishedCounts:data.counts.published},null,2));
