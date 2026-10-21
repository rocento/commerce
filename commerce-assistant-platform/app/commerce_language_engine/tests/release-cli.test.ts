import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {exportDatabaseRelease} from '../scripts/export-db-release.ts';
import {readFile,mkdtemp,writeFile,rm,cp,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {runtimeSha256} from '../src/runtime-identity.ts';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {releaseArguments} from '../scripts/release.ts';
import {evaluateReleaseCandidate} from '../scripts/release-evaluation.ts';
import {decodeReleaseBundle,createReleaseBundle,type ReleasePayload} from '../scripts/deployment-release.ts';
import type {Dictionary,CorpusCase} from '../src/types.ts';

const root=new URL('../',import.meta.url),exec=promisify(execFile);
const dictionary=(recognitionFixture(JSON.parse(await readFile(new URL('data/compiled.json',root),'utf8')))) as Dictionary;
const identity={releaseId:randomUUID(),runtimeSha256:await runtimeSha256()};
const corpus:CorpusCase[]=[{text:'find a laptop',intent:'PRODUCT_SEARCH',status:'RESOLVED',difficulty:'EASY'}];

test('release CLI validates required promotion evidence and expected state before connecting',()=>{
 const id=randomUUID();
 assert.throws(()=>releaseArguments(['promote','--release-id',id]),/evaluation-id/);
 assert.throws(()=>releaseArguments(['promote','--release-id',id,'--evaluation-id',randomUUID(),'--actor','reviewer','--reason','reviewed']),/expected-active/);
 assert.throws(()=>releaseArguments(['rollback','--release-id',id,'--actor','reviewer','--reason','incident','--expected-active','none']),/expected-active/);
 assert.throws(()=>releaseArguments(['draft-freeze','--draft-id',id,'--revision','0']),/revision/);
 assert.equal(releaseArguments(['stage','--artifact','a.json','--corpus','c.jsonl','--expected-active','none']).expectedActiveReleaseId,null);
});

test('release rubric fails on actual archived expectation mismatches and refuses empty evidence',()=>{
 assert.equal(evaluateReleaseCandidate(dictionary,corpus,identity).passed,true);
 const failed=evaluateReleaseCandidate(dictionary,[{...corpus[0],intent:'VIEW_CART'}],identity);
 assert.equal(failed.passed,false);assert.equal(failed.failureCount,1);
 assert.throws(()=>evaluateReleaseCandidate(dictionary,[],identity),/nonempty/);
});

const adminUrl=process.env.RELEASE_TEST_DATABASE_URL;
test('release CLI freezes, exports, evaluates, promotes and rolls back exact candidates',{skip:!adminUrl,timeout:120000},async t=>{
 const admin=new pg.Client({connectionString:adminUrl});await admin.connect();
 const name='release_cli_'+randomUUID().replaceAll('-',''),directory=await mkdtemp(join(tmpdir(),'release-cli-'));
 let created=false;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  const target=new URL(adminUrl!);target.pathname='/'+name;
  const env={...process.env,DATABASE_URL:target.href,CLE_EXPORT_OUTPUT_DIR:directory,CLE_DEPLOY_DATA_DIR:directory,CLE_EXPANSION_REPORT:join(directory,'expansion-report.json')};
  const run=(args:string[])=>exec(process.execPath,args,{cwd:root,env,timeout:30000});
  const release=async(command:string,...args:string[])=>JSON.parse((await run(['scripts/release.ts',command,...args])).stdout);
  const artifact=join(directory,'authoring.json'),cases=join(directory,'cases.jsonl');
  await writeFile(artifact,JSON.stringify(dictionary));await writeFile(cases,corpus.map(row=>JSON.stringify(row)).join('\n')+'\n');
  await run(['scripts/deploy-start.ts','--migrate-only']);
  const draft=await release('draft-new','--artifact',artifact,'--corpus',cases,'--expected-active','none');
  const initial=await release('draft-freeze','--draft-id',draft.draftId,'--revision','1');
  await release('evaluate','--release-id',initial.releaseId);
  await release('bootstrap','--release-id',initial.releaseId,'--actor','test','--reason','empty installation');
  await assert.rejects(release('bootstrap','--release-id',initial.releaseId,'--actor','test','--reason','duplicate'),/only allowed/);
  const changed={...dictionary,requestPrefixes:[...(dictionary.requestPrefixes??[]),'would you please kindly']};
  await writeFile(artifact,JSON.stringify(changed));
  const candidate=await release('stage','--artifact',artifact,'--corpus',cases,'--expected-active',initial.releaseId);
  const exported=JSON.parse((await run(['scripts/export-db-release.ts','--release-id',candidate.releaseId])).stdout);
  assert.equal(exported.releaseId,candidate.releaseId);
  const bundle=join(directory,'deployment-release.json.gz');
  const decoded=decodeReleaseBundle(await readFile(bundle));assert.equal(decoded.payload.format,2);
  assert.equal((decoded.payload as ReleasePayload).identity.releaseId,candidate.releaseId);
  const originalBundle=await readFile(bundle);await rm(bundle);
  await assert.rejects(run(['scripts/deploy-start.ts','--verify-only']),/requires a version 2 deployment bundle/);
  await writeFile(bundle,createReleaseBundle({format:1,artifact:decoded.payload.artifact,corpus:decoded.payload.corpus,manifest:decoded.payload.manifest}));
  await assert.rejects(run(['scripts/deploy-start.ts','--verify-only']),/requires a version 2 deployment bundle/);
  await writeFile(bundle,originalBundle);
  // Importing a known immutable UUID/content pair is idempotent and never activates it.
  const imported=await release('import','--bundle',bundle,'--expected-active',initial.releaseId);assert.equal(imported.releaseId,candidate.releaseId);
  assert.equal((await release('inspect','--release-id',initial.releaseId)).active,true);
  await assert.rejects(run(['scripts/deploy-start.ts','--verify-only']),/Active language release differs/);
  const reviewedFile=join(directory,'reviewed.json');
  await writeFile(reviewedFile,JSON.stringify({code:'cli-regression',revision:1,reviewedBy:'test',cases:[{key:'laptop',text:'find a laptop',language:'en',industry:'CORE',expected:{intent:'PRODUCT_SEARCH',status:'RESOLVED'}}]}));
  const reviewed=JSON.parse((await run(['scripts/quality.ts','dataset-import','--file',reviewedFile])).stdout);
  const evaluation=await release('evaluate','--release-id',candidate.releaseId,'--dataset-id',reviewed.datasetId);assert.equal(evaluation.passed,true);assert.equal(evaluation.reviewedDataset.count,1);
  await release('promote','--release-id',candidate.releaseId,'--evaluation-id',evaluation.evaluationId,'--expected-active',initial.releaseId,'--actor','test','--reason','passing exact candidate');
  await run(['scripts/deploy-start.ts','--verify-only']);
  // A parser-only code change plus re-export cannot replace runtime evaluation.
  const changedRuntime=join(directory,'changed-runtime');await mkdir(changedRuntime);
  for(const folder of ['src','scripts','migrations'])await cp(new URL(folder,root),join(changedRuntime,folder),{recursive:true});
  for(const file of ['package.json','package-lock.json'])await cp(new URL(file,root),join(changedRuntime,file));
  await symlink(fileURLToPath(new URL('node_modules/',root)),join(changedRuntime,'node_modules'),'dir');
  const runtimeFile=join(changedRuntime,'src/runtime-identity.ts');await writeFile(runtimeFile,(await readFile(runtimeFile,'utf8'))+'\n// Different parser build in isolated regression fixture.\n');
  await exec(process.execPath,['scripts/export-db-release.ts','--release-id',candidate.releaseId],{cwd:changedRuntime,env,timeout:30000});
  await assert.rejects(exec(process.execPath,['scripts/deploy-start.ts','--verify-only'],{cwd:changedRuntime,env,timeout:30000}),/no passing evaluation for this exact runtime/);
  // Restarting the older artifact must fail without reactivating its archive.
  await run(['scripts/export-db-release.ts','--release-id',initial.releaseId]);
  await assert.rejects(run(['scripts/deploy-start.ts','--verify-only']),/Active language release differs/);
  assert.equal((await release('inspect','--release-id',candidate.releaseId)).active,true);
  await release('rollback','--release-id',initial.releaseId,'--expected-active',candidate.releaseId,'--actor','test','--reason','rollback rehearsal');
  await run(['scripts/deploy-start.ts','--verify-only']);
  const industry=JSON.parse((await run(['scripts/sync-industry-terms.ts','--apply'])).stdout);assert.equal(industry.activated,false);assert.equal((await release('inspect','--release-id',initial.releaseId)).active,true);
  const expansion=JSON.parse((await run(['scripts/sync-data-expansion.ts','--apply'])).stdout);assert.equal(expansion.activated,false);assert.equal((await release('inspect','--release-id',initial.releaseId)).active,true);
  // Valid wrapper checksum cannot hide a forged immutable content hash.
  const forged=structuredClone(decoded.payload) as ReleasePayload;forged.identity.artifactSha256='0'.repeat(64);
  await writeFile(bundle,createReleaseBundle(forged));
  await assert.rejects(release('import','--bundle',bundle,'--expected-active',initial.releaseId),/artifact hash mismatch/);
 }finally{
  if(created){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[name]);await admin.query(`DROP DATABASE "${name}"`);}
  await admin.end();await rm(directory,{recursive:true,force:true});
 }
});


test('legacy immutable snapshot imports into a fresh database only as an explicit baseline',{skip:!adminUrl,timeout:60000},async()=>{
 const admin=new pg.Client({connectionString:adminUrl});await admin.connect();
 const name='release_baseline_'+randomUUID().replaceAll('-',''),directory=await mkdtemp(join(tmpdir(),'release-baseline-'));
 let created=false;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  const target=new URL(adminUrl!);target.pathname='/'+name;
  const env={...process.env,DATABASE_URL:target.href,CLE_DEPLOY_DATA_DIR:directory};
  const run=(args:string[])=>exec(process.execPath,args,{cwd:root,env,timeout:30000});
  await run(['scripts/deploy-start.ts','--migrate-only']);
  const releaseId=randomUUID(),originParent=randomUUID();
  await exportDatabaseRelease({id:releaseId,base_release_id:originParent,dictionary_version:dictionary.version,fingerprint:dictionary.generationFingerprint!,artifact:dictionary,corpus_gzip:gzipSync(corpus.map(row=>JSON.stringify(row)).join('\n')+'\n'),manifest:{source:'legacy-immutable-baseline'}},pathToFileURL(directory+'/'));
  const args=['scripts/release.ts','import-baseline','--bundle',join(directory,'deployment-release.json.gz'),'--expected-active','none'];
  const first=JSON.parse((await run(args)).stdout),again=JSON.parse((await run(args)).stdout);assert.equal(first.releaseId,releaseId);assert.equal(again.releaseId,releaseId);
  await assert.rejects(run(['scripts/release.ts','evaluate','--release-id',releaseId]),/no candidate provenance/);
  await run(['scripts/release.ts','bootstrap','--release-id',releaseId,'--actor','test','--reason','reviewed legacy snapshot restore']);
  await run(['scripts/deploy-start.ts','--verify-only']);
  const inspected=JSON.parse((await run(['scripts/release.ts','inspect','--release-id',releaseId])).stdout);assert.equal(inspected.fingerprint,dictionary.generationFingerprint);assert.equal(inspected.baseReleaseId,originParent);assert.equal(inspected.active,true);
 }finally{
  if(created){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[name]);await admin.query(`DROP DATABASE "${name}"`);}
  await admin.end();await rm(directory,{recursive:true,force:true});
 }
});
