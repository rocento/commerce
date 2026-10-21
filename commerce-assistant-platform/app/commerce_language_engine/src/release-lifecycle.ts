import {withDictionaryRecognition} from './recognition-rules.ts';
import {persistRecognitionRules} from './recognition-store.ts';
/** Immutable draft snapshots and candidates; evaluation runs outside promotion transactions. */
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {gzipSync,gunzipSync} from 'node:zlib';
import type {PoolClient} from 'pg';
import {compile} from './compiler.ts';
import {assertKnowledgeReviewed,assertKnowledgeUpgrade} from './rule-governance.ts';
import {persistKnowledgePack} from './knowledge-pack-store.ts';
import {saveReviewedResults,type ReviewedEvaluation} from './reviewed-evaluation.ts';
import {knowledgeHash} from './language-knowledge.ts';
import type {Dictionary,CorpusCase} from './types.ts';
export type ReleaseClient=Pick<PoolClient,'query'>;
export type DraftChange={kind:string;key:string;payload:unknown};
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
export function releaseContentHashes(artifact:unknown,archive:Buffer){const {corpus:_embeddedCorpus,...dictionary}=artifact as Record<string,unknown>;return {artifactSha256:sha(canonical(dictionary)),corpusSha256:sha(gunzipSync(archive))};}
const archived=(corpus:CorpusCase[])=>gzipSync(Buffer.from(corpus.map(row=>JSON.stringify(row)).join('\n')+(corpus.length?'\n':'')));
export function dictionaryContentFingerprint(dictionary:Dictionary){const {corpus:_corpus,generationFingerprint:_claimed,...artifact}=dictionary;return knowledgeHash(artifact);}
function content(dictionary:Dictionary){const {corpus:_corpus,...artifact}=dictionary;return {...artifact,generationFingerprint:dictionaryContentFingerprint(dictionary)};}
function required(value:string,label:string){if(!value?.trim())throw new Error(label+' is required');}
function hash(value:string,label:string){if(!/^[a-f0-9]{64}$/.test(value))throw new Error(label+' must be a SHA-256 hash');}
async function transaction<T>(c:ReleaseClient,fn:()=>Promise<T>){await c.query('BEGIN');try{const result=await fn();await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}}
export async function currentReleaseId(c:ReleaseClient):Promise<string|null>{return (await c.query("SELECT release_id FROM release.channels WHERE channel='production'")).rows[0]?.release_id??null;}
export async function loadRelease(c:ReleaseClient,releaseId:string){
 const row=(await c.query('SELECT d.*,coalesce(c.artifact_sha256,i.artifact_sha256) AS artifact_sha256,coalesce(c.corpus_sha256,i.corpus_sha256) AS corpus_sha256,coalesce(c.base_release_id,i.origin_parent_release_id) AS base_release_id,c.draft_id,c.draft_revision,i.release_id IS NOT NULL AS imported_baseline FROM release.dictionaries d LEFT JOIN release.candidates c ON c.release_id=d.id LEFT JOIN release.imported_baselines i ON i.release_id=d.id WHERE d.id=$1',[releaseId])).rows[0];
 if(!row)throw new Error('Dictionary release not found: '+releaseId);
 if(!row.corpus_gzip)throw new Error('Release has no archived corpus; cannot verify candidate');
 const hashes=releaseContentHashes(row.artifact,row.corpus_gzip);
 if(row.artifact_sha256&&(row.artifact_sha256!==hashes.artifactSha256||row.corpus_sha256!==hashes.corpusSha256))throw new Error('Release content identity mismatch');
 const corpus=gunzipSync(row.corpus_gzip).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)) as CorpusCase[];
 return {...row,...hashes,releaseId:row.id,dictionary:{...row.artifact,version:row.dictionary_version,generationFingerprint:row.fingerprint,corpus} as Dictionary};
}
export type StageReleaseInput={dictionary:Dictionary;corpus:CorpusCase[];corpusArchive?:Buffer;baseReleaseId:string|null;source:string;manifest?:Record<string,unknown>;change?:DraftChange;releaseId?:string};
async function prepareGovernedCandidate(c:ReleaseClient,artifact:Record<string,unknown>,baseId:string|null){
 const next=(artifact as unknown as Dictionary).languageKnowledge;
 const previous=baseId?(await c.query('SELECT artifact FROM release.dictionaries WHERE id=$1',[baseId])).rows[0]?.artifact?.languageKnowledge:undefined;
 assertKnowledgeUpgrade(previous,next);
 // Legacy archives retain their exact provenance. New governed snapshots use
 // the same relational projection regardless of importer or draft CLI path.
 if(next?.ruleGovernance)await persistKnowledgePack(c,next);
}
/** Caller owns the transaction. Used by additive importers so pack rows and candidate commit together. */
export async function registerCandidate(c:ReleaseClient,input:{releaseId:string;baseReleaseId:string|null;artifact:Record<string,unknown>;archive:Buffer;source:string;manifest?:Record<string,unknown>;change?:DraftChange}){
 required(input.source,'Draft source');
 await withDictionaryRecognition(input.artifact as unknown as Dictionary,()=>prepareGovernedCandidate(c,input.artifact,input.baseReleaseId));
 const expectedFingerprint=dictionaryContentFingerprint({...input.artifact,corpus:[]} as unknown as Dictionary);
 if(input.artifact.generationFingerprint!==expectedFingerprint)throw new Error('Candidate fingerprint does not match dictionary content');
 const stored=(await c.query('SELECT artifact,corpus_gzip,fingerprint FROM release.dictionaries WHERE id=$1',[input.releaseId])).rows[0];
 const hashes=releaseContentHashes(input.artifact,input.archive);
 if(!stored||stored.fingerprint!==expectedFingerprint||!isDeepStrictEqual(releaseContentHashes(stored.artifact,stored.corpus_gzip),hashes))throw new Error('Candidate identity differs from its immutable release');
 await persistRecognitionRules(c,input.releaseId,(input.artifact as unknown as Dictionary).recognitionRules);
 const draftId=randomUUID();
 await c.query('INSERT INTO release.drafts(id,base_release_id,source) VALUES($1,$2,$3)',[draftId,input.baseReleaseId,input.source]);
 await c.query('INSERT INTO release.draft_revisions(draft_id,revision,artifact,corpus_gzip,manifest) VALUES($1,1,$2,$3,$4)',[draftId,input.artifact,input.archive,input.manifest??{}]);
 const change=input.change??{kind:'snapshot',key:'dictionary',payload:{source:input.source}};
 await c.query('INSERT INTO release.draft_changes(draft_id,revision,change_key,kind,payload) VALUES($1,1,$2,$3,$4)',[draftId,change.key,change.kind,JSON.stringify(change.payload)]);
 await c.query('INSERT INTO release.candidates(release_id,draft_id,draft_revision,base_release_id,artifact_sha256,corpus_sha256) VALUES($1,$2,1,$3,$4,$5)',[input.releaseId,draftId,input.baseReleaseId,hashes.artifactSha256,hashes.corpusSha256]);
 return {releaseId:input.releaseId,draftId,...hashes};
}
export async function stageRelease(c:ReleaseClient,input:StageReleaseInput){
 // Compile before starting any DB transaction. Invalid snapshots never become candidates.
 compile(input.dictionary);required(input.source,'Draft source');
 const artifact=content(input.dictionary),archive=input.corpusArchive??archived(input.corpus),releaseId=input.releaseId??randomUUID();
 if(input.corpusArchive){
  const restored=gunzipSync(archive).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  if(!isDeepStrictEqual(restored,input.corpus))throw new Error('Imported corpus archive differs from candidate corpus');
 }
 const fingerprint=artifact.generationFingerprint;
 if(input.releaseId&&input.dictionary.generationFingerprint&&input.dictionary.generationFingerprint!==fingerprint)throw new Error('Imported dictionary fingerprint does not match its content');
 return transaction(c,async()=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1::uuid::text))',[releaseId]);
  const existing=(await c.query('SELECT id FROM release.dictionaries WHERE id=$1',[releaseId])).rows[0];
  if(existing){
   const previous=await loadRelease(c,releaseId),hashes=releaseContentHashes(artifact,archive);
   if(previous.fingerprint!==fingerprint||previous.artifactSha256!==hashes.artifactSha256||previous.corpusSha256!==hashes.corpusSha256||previous.base_release_id!==input.baseReleaseId)throw new Error('Existing release ID has different immutable content or provenance');
   if(!previous.draft_id)throw new Error('Existing release ID has no candidate provenance');
   return {releaseId,draftId:previous.draft_id,...hashes,fingerprint,dictionaryVersion:input.dictionary.version,corpusCases:input.corpus.length};
  }
  if(input.baseReleaseId&&!((await c.query('SELECT 1 FROM release.dictionaries WHERE id=$1',[input.baseReleaseId])).rowCount))throw new Error('Draft base release not found');
  const manifest={...input.manifest,source:input.source,fingerprint,corpusCases:input.corpus.length};
  await c.query('INSERT INTO release.dictionaries(id,dictionary_version,fingerprint,schema_version,artifact,corpus_gzip,manifest) VALUES($1,$2,$3,$4,$5,$6,$7)',[releaseId,input.dictionary.version,fingerprint,input.dictionary.schemaVersion??2,artifact,archive,manifest]);
  const result=await registerCandidate(c,{releaseId,baseReleaseId:input.baseReleaseId,artifact,archive,source:input.source,manifest,change:input.change});
  await c.query('INSERT INTO utterance.generation_runs(dictionary_version,fingerprint,manifest,release_id,active) VALUES($1,$2,$3,$4,false)',[input.dictionary.version,fingerprint,manifest,releaseId]);
  return {...result,fingerprint,dictionaryVersion:input.dictionary.version,corpusCases:input.corpus.length};
 });
}
/** Evidence must include the exact identity obtained before evaluation began. */
export async function recordReleaseEvaluation(c:ReleaseClient,input:{releaseId:string;artifactSha256:string;corpusSha256:string;runtimeSha256:string;rubricVersion:string;contractVersion:string;passed:boolean;report:Record<string,unknown>;reviewed?:ReviewedEvaluation}){
 hash(input.runtimeSha256,'Runtime identity');required(input.rubricVersion,'Rubric version');required(input.contractVersion,'Contract version');
 const candidate=await loadRelease(c,input.releaseId);
 if(!candidate.draft_id)throw new Error('Release has no candidate provenance; create an explicit draft from the immutable release');
 if(candidate.artifactSha256!==input.artifactSha256||candidate.corpusSha256!==input.corpusSha256)throw new Error('Evaluation content identity mismatch');
 if(input.reviewed&&!input.reviewed.passed&&input.passed)throw new Error('Failing reviewed cases cannot approve a release');
 const id=randomUUID();
 await transaction(c,async()=>{
  await c.query('INSERT INTO release.evaluations(id,release_id,artifact_sha256,corpus_sha256,runtime_sha256,rubric_version,contract_version,passed,report) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,input.releaseId,input.artifactSha256,input.corpusSha256,input.runtimeSha256,input.rubricVersion,input.contractVersion,input.passed,input.report]);
  if(input.reviewed)await saveReviewedResults(c,id,input.reviewed);
 });
 return id;
}
export type PromotionOptions={releaseId:string;evaluationId:string;expectedActiveReleaseId:string|null;runtimeSha256:string;rubricVersion:string;contractVersion:string;actor:string;reason:string};
async function activate(c:ReleaseClient,input:{releaseId:string;actor:string;reason:string},previous:string|null,operation:'promotion'|'bootstrap'|'rollback',evaluationId:string|null){
 required(input.actor,'Actor');required(input.reason,'Reason');
 await c.query('UPDATE utterance.generation_runs SET active=false WHERE active');
 await c.query('UPDATE utterance.generation_runs SET active=true WHERE id=(SELECT id FROM utterance.generation_runs WHERE release_id=$1 ORDER BY id DESC LIMIT 1)',[input.releaseId]);
 await c.query("INSERT INTO release.activations(channel,release_id,previous_release_id,evaluation_id,actor,reason,operation) VALUES('production',$1,$2,$3,$4,$5,$6)",[input.releaseId,previous,evaluationId,input.actor,input.reason,operation]);
 await c.query("INSERT INTO release.channels(channel,release_id) VALUES('production',$1) ON CONFLICT(channel) DO UPDATE SET release_id=EXCLUDED.release_id,updated_at=now()",[input.releaseId]);
 return {releaseId:input.releaseId,previousReleaseId:previous,operation};
}
export async function promoteRelease(c:ReleaseClient,input:PromotionOptions){
 hash(input.runtimeSha256,'Runtime identity');required(input.rubricVersion,'Rubric version');required(input.contractVersion,'Contract version');
 // Hash/decompress before the short lock. Both candidate and evidence are immutable.
 const candidate=await loadRelease(c,input.releaseId);
 compile(candidate.dictionary);
 withDictionaryRecognition(candidate.dictionary,()=>assertKnowledgeReviewed(candidate.dictionary.languageKnowledge));
 const evidence=(await c.query('SELECT * FROM release.evaluations WHERE id=$1',[input.evaluationId])).rows[0];
 if(!evidence||!evidence.passed||evidence.release_id!==input.releaseId||evidence.artifact_sha256!==candidate.artifactSha256||evidence.corpus_sha256!==candidate.corpusSha256||evidence.runtime_sha256!==input.runtimeSha256||evidence.rubric_version!==input.rubricVersion||evidence.contract_version!==input.contractVersion)throw new Error('Promotion requires passing evaluation for the exact candidate, runtime, rubric and contract');
 return transaction(c,async()=>{
  await c.query('SELECT pg_advisory_xact_lock(57439)');
  const active=await currentReleaseId(c);
  if(active!==input.expectedActiveReleaseId)throw new Error('Active release changed; rebase and reevaluate before promotion');
  if(candidate.base_release_id!==active)throw new Error('Candidate base is stale; create a draft from the current release and reevaluate');
  const previous=active?await loadRelease(c,active):undefined;
  assertKnowledgeUpgrade(previous?.dictionary.languageKnowledge,candidate.dictionary.languageKnowledge);
  return activate(c,input,active,'promotion',input.evaluationId);
 });
}
export async function bootstrapRelease(c:ReleaseClient,input:{releaseId:string;actor:string;reason:string}){
 const candidate=await loadRelease(c,input.releaseId);compile(candidate.dictionary);withDictionaryRecognition(candidate.dictionary,()=>assertKnowledgeReviewed(candidate.dictionary.languageKnowledge));
 return transaction(c,async()=>{
  await c.query('SELECT pg_advisory_xact_lock(57439)');
  if(await currentReleaseId(c)||(await c.query('SELECT 1 FROM release.activations LIMIT 1')).rowCount)throw new Error('Bootstrap is only allowed on an empty, never-activated database');
  await c.query("INSERT INTO release.baselines(release_id,origin) VALUES($1,'explicit-bootstrap')",[input.releaseId]);
  return activate(c,input,null,'bootstrap',null);
 });
}
export async function rollbackRelease(c:ReleaseClient,input:{releaseId:string;expectedActiveReleaseId:string;actor:string;reason:string}){
 await loadRelease(c,input.releaseId);
 return transaction(c,async()=>{
  await c.query('SELECT pg_advisory_xact_lock(57439)');
  const active=await currentReleaseId(c);
  if(active!==input.expectedActiveReleaseId)throw new Error('Active release changed; rollback expectation is stale');
  const vetted=await c.query("SELECT 1 FROM release.baselines WHERE release_id=$1 UNION ALL SELECT 1 FROM release.activations WHERE release_id=$1 AND operation IN ('promotion','bootstrap') LIMIT 1",[input.releaseId]);
  if(!vetted.rowCount)throw new Error('Rollback target must be an existing baseline or a previously approved activation');
  return activate(c,input,active,'rollback',null);
 });
}

export async function createReleaseDraft(c:ReleaseClient,input:Omit<StageReleaseInput,'releaseId'>){
 compile(input.dictionary);required(input.source,'Draft source');
 return transaction(c,async()=>{
  const draftId=randomUUID();
  await c.query('INSERT INTO release.drafts(id,base_release_id,source) VALUES($1,$2,$3)',[draftId,input.baseReleaseId,input.source]);
  await insertDraftRevision(c,draftId,1,input);
  return {draftId,revision:1,baseReleaseId:input.baseReleaseId};
 });
}
async function insertDraftRevision(c:ReleaseClient,draftId:string,revision:number,input:{dictionary:Dictionary;corpus:CorpusCase[];manifest?:Record<string,unknown>;change?:DraftChange}){
 await c.query('INSERT INTO release.draft_revisions(draft_id,revision,artifact,corpus_gzip,manifest) VALUES($1,$2,$3,$4,$5)',[draftId,revision,content(input.dictionary),archived(input.corpus),input.manifest??{}]);
 const change=input.change??{kind:'snapshot',key:'dictionary',payload:{}};
 required(change.key,'Change key');required(change.kind,'Change kind');
 await c.query('INSERT INTO release.draft_changes(draft_id,revision,change_key,kind,payload) VALUES($1,$2,$3,$4,$5)',[draftId,revision,change.key,change.kind,JSON.stringify(change.payload)]);
}
/** Every revision is a complete reviewed snapshot with its explicit change record. */
export async function reviseReleaseDraft(c:ReleaseClient,input:{draftId:string;expectedRevision:number;dictionary:Dictionary;corpus:CorpusCase[];manifest?:Record<string,unknown>;change:DraftChange}){
 compile(input.dictionary);
 return transaction(c,async()=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1::uuid::text))',[input.draftId]);
  const latest=(await c.query('SELECT max(revision) AS revision FROM release.draft_revisions WHERE draft_id=$1',[input.draftId])).rows[0]?.revision;
  if(latest!==input.expectedRevision)throw new Error('Draft revision changed; reload before editing');
  const revision=latest+1;
  await insertDraftRevision(c,input.draftId,revision,input);
  return {draftId:input.draftId,revision};
 });
}
export async function freezeReleaseDraft(c:ReleaseClient,input:{draftId:string;revision:number;releaseId?:string}){
 const row=(await c.query('SELECT r.*,d.base_release_id,d.source FROM release.draft_revisions r JOIN release.drafts d ON d.id=r.draft_id WHERE draft_id=$1 AND revision=$2',[input.draftId,input.revision])).rows[0];
 if(!row)throw new Error('Draft revision not found');
 const corpus=gunzipSync(row.corpus_gzip).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
 compile({...row.artifact,corpus});
 const hashes=releaseContentHashes(row.artifact,row.corpus_gzip),fingerprint=dictionaryContentFingerprint({...row.artifact,corpus:[]});
 if(row.artifact.generationFingerprint!==fingerprint)throw new Error('Draft fingerprint does not match its immutable content');
 return transaction(c,async()=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1::uuid::text))',[input.draftId]);
  const previous=(await c.query('SELECT release_id FROM release.candidates WHERE draft_id=$1 AND draft_revision=$2',[input.draftId,input.revision])).rows[0];
  if(previous){if(input.releaseId&&input.releaseId!==previous.release_id)throw new Error('Draft revision already frozen with a different release ID');return {releaseId:previous.release_id,draftId:input.draftId,fingerprint,...hashes};}
  const releaseId=input.releaseId??randomUUID(),manifest={...row.manifest,source:row.source,fingerprint,corpusCases:corpus.length};
  await withDictionaryRecognition(row.artifact,()=>prepareGovernedCandidate(c,row.artifact,row.base_release_id));
  await c.query('INSERT INTO release.dictionaries(id,dictionary_version,fingerprint,schema_version,artifact,corpus_gzip,manifest) VALUES($1,$2,$3,$4,$5,$6,$7)',[releaseId,row.artifact.version,fingerprint,row.artifact.schemaVersion??2,row.artifact,row.corpus_gzip,manifest]);
  await persistRecognitionRules(c,releaseId,row.artifact.recognitionRules);
  await c.query('INSERT INTO release.candidates(release_id,draft_id,draft_revision,base_release_id,artifact_sha256,corpus_sha256) VALUES($1,$2,$3,$4,$5,$6)',[releaseId,input.draftId,input.revision,row.base_release_id,hashes.artifactSha256,hashes.corpusSha256]);
  await c.query('INSERT INTO utterance.generation_runs(dictionary_version,fingerprint,manifest,release_id,active) VALUES($1,$2,$3,$4,false)',[row.artifact.version,fingerprint,manifest,releaseId]);
  return {releaseId,draftId:input.draftId,fingerprint,...hashes};
 });
}

/** Preserve a verified external snapshot without inventing local parent, draft or evaluation history. */
export async function importBaselineRelease(c:ReleaseClient,input:{releaseId:string;dictionary:Dictionary;corpus:CorpusCase[];corpusArchive:Buffer;baseReleaseId:string|null;artifactSha256:string;corpusSha256:string;runtimeSha256:string;manifest?:Record<string,unknown>}){
 hash(input.runtimeSha256,'Source runtime identity');
 required(input.dictionary.generationFingerprint??'','Imported fingerprint');
 const {corpus:_embeddedCorpus,...artifact}=input.dictionary,hashes=releaseContentHashes(artifact,input.corpusArchive);
 const restored=gunzipSync(input.corpusArchive).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
 if(!isDeepStrictEqual(restored,input.corpus))throw new Error('Imported corpus archive differs from baseline corpus');
 if(hashes.artifactSha256!==input.artifactSha256||hashes.corpusSha256!==input.corpusSha256)throw new Error('Imported baseline content identity differs from verified bundle');
 compile({...input.dictionary,corpus:input.corpus});
 return transaction(c,async()=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1::uuid::text))',[input.releaseId]);
  const existing=(await c.query('SELECT id FROM release.dictionaries WHERE id=$1',[input.releaseId])).rows[0];
  if(existing){
   const previous=await loadRelease(c,input.releaseId);
   if(previous.fingerprint!==input.dictionary.generationFingerprint||previous.artifactSha256!==hashes.artifactSha256||previous.corpusSha256!==hashes.corpusSha256||(previous.base_release_id??null)!==input.baseReleaseId)throw new Error('Existing release ID has different immutable content or provenance');
   return {releaseId:input.releaseId,fingerprint:previous.fingerprint,...hashes,imported:false};
  }
  const manifest={...input.manifest,source:'verified-baseline-import',fingerprint:input.dictionary.generationFingerprint,corpusCases:input.corpus.length};
  await c.query('INSERT INTO release.dictionaries(id,dictionary_version,fingerprint,schema_version,artifact,corpus_gzip,manifest) VALUES($1,$2,$3,$4,$5,$6,$7)',[input.releaseId,input.dictionary.version,input.dictionary.generationFingerprint,input.dictionary.schemaVersion??2,artifact,input.corpusArchive,manifest]);
  await persistRecognitionRules(c,input.releaseId,input.dictionary.recognitionRules);
  await c.query('INSERT INTO release.imported_baselines(release_id,origin_parent_release_id,artifact_sha256,corpus_sha256,runtime_sha256) VALUES($1,$2,$3,$4,$5)',[input.releaseId,input.baseReleaseId,hashes.artifactSha256,hashes.corpusSha256,input.runtimeSha256]);
  await c.query('INSERT INTO utterance.generation_runs(dictionary_version,fingerprint,manifest,release_id,active) VALUES($1,$2,$3,$4,false)',[input.dictionary.version,input.dictionary.generationFingerprint,manifest,input.releaseId]);
  return {releaseId:input.releaseId,fingerprint:input.dictionary.generationFingerprint,...hashes,imported:true};
 });
}
