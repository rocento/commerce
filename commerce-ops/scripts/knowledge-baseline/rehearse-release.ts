/** Exact immutable release rehearsal in a newly created disposable loopback DB.
 * Never connects to the main local database or production and never approves a
 * failed evaluation. Credentials stay in process memory and child environments.
 */
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {importBaselineRelease,bootstrapRelease,stageRelease,loadRelease,currentReleaseId,promoteRelease,rollbackRelease} from '../../commerce-assistant-platform/app/commerce_language_engine/src/release-lifecycle.ts';
import {runtimeSha256} from '../../commerce-assistant-platform/app/commerce_language_engine/src/runtime-identity.ts';
import {prepareDatabaseExport} from '../../commerce-assistant-platform/app/commerce_language_engine/scripts/export-db-release.ts';
import {readDeploymentRelease,RELEASE_CONTRACT_VERSION} from '../../commerce-assistant-platform/app/commerce_language_engine/scripts/deployment-release.ts';
import {RELEASE_RUBRIC_VERSION} from '../../commerce-assistant-platform/app/commerce_language_engine/scripts/release-evaluation.ts';
const root=new URL('../../',import.meta.url),engine=new URL('commerce-assistant-platform/app/commerce_language_engine/',root);
const pg=createRequire(new URL('package.json',engine))('pg');
const output=new URL('output/enterprise-knowledge-release-prep-20261010/',root);
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const write=(name:string,value:unknown)=>writeFile(new URL(name,output),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const captured=JSON.parse(await readFile(new URL('production-baseline.json',output),'utf8'));
const dictionary=JSON.parse(await readFile(new URL('output/enterprise-knowledge-expansion-20261010/candidate.json',root),'utf8'));
const capturedRow={...captured.release,corpus_gzip:Buffer.from(captured.release.corpus_gzip,'base64')};
const corpus=gunzipSync(capturedRow.corpus_gzip).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
const currentRuntime=await runtimeSha256();
const connection=new URL(process.env.PHASE3_TEST_DATABASE_URL??'');
assert.equal(connection.hostname,'127.0.0.1');assert.equal(connection.port,'57433');assert.equal(connection.pathname,'/postgres');
const suffix=randomBytes(8).toString('hex'),database='release_rehearsal_'+suffix;
const ownerUrl=new URL(connection);ownerUrl.pathname='/'+database;
const admin=new pg.Client({connectionString:connection.href});
let client:any,created=false;
const roles:{store:string;role:string;tenant:string;password:string;url:string}[]=[];
const report:any={startedAt:new Date().toISOString(),scope:'Disposable database only; no production or main local database mutation',database,baseReleaseId:capturedRow.id,baseRuntimeSha256:captured.runtimeSha256,runtimeSha256:currentRuntime,corpusCases:corpus.length,productionChanged:false,mainLocalDatabaseChanged:false,activated:false};
async function child(args:string[],env:Record<string,string>,logName:string){
 const log=await import('node:fs').then(fs=>fs.createWriteStream(new URL(logName,output),{flags:'wx',mode:0o600}));
 return await new Promise<number>((resolve,reject)=>{
  const process=spawn('node',args,{cwd:fileURLToPath(engine),env:{...globalThis.process.env,...env},stdio:['ignore','pipe','pipe']});
  process.stdout.pipe(log);process.stderr.pipe(log);
  process.on('error',reject);process.on('close',code=>{log.end();resolve(code??1);});
 });
}
async function exportPair(row:any,hash:string,directory:string){
 const prepared=prepareDatabaseExport(row,hash),destination=new URL(directory+'/',output);
 await mkdir(destination);
 await writeFile(new URL('compiled.json',destination),JSON.stringify(prepared.artifact),{flag:'wx'});
 await writeFile(new URL('deployment-release.json.gz',destination),prepared.bundle,{flag:'wx',mode:0o600});
 const checked=await readDeploymentRelease(destination,{verifyRuntime:hash===currentRuntime});
 assert.equal(checked.release?.payload.format,2);
 const identity=(checked.release!.payload as any).identity;assert.equal(identity.runtimeSha256,hash);
 return {directory,identity,bundleSha256:sha(prepared.bundle),compiledSha256:sha(JSON.stringify(prepared.artifact)),corpusCases:prepared.corpus.length};
}
await admin.connect();
try{
 await admin.query(`CREATE DATABASE "${database}"`);created=true;
 globalThis.process.env.DATABASE_URL=ownerUrl.href;
 const db=await import('../../commerce-assistant-platform/app/commerce_language_engine/src/database.ts');
 await db.migrate();await db.closeDb();
 client=new pg.Client({connectionString:ownerUrl.href});await client.connect();
 report.migrations=(await client.query('SELECT filename,sha256 FROM public.schema_migrations ORDER BY filename')).rows;
 const applied=new Map(report.migrations.map((r:any)=>[r.filename,r.sha256]));
 for(const migration of captured.migrations)assert.equal(applied.get(migration.filename),migration.sha256,'Captured production migration checksum differs: '+migration.filename);
 report.importedBaseline=await importBaselineRelease(client,{releaseId:capturedRow.id,dictionary:capturedRow.artifact,corpus,corpusArchive:capturedRow.corpus_gzip,baseReleaseId:capturedRow.base_release_id??null,artifactSha256:capturedRow.artifactSha256,corpusSha256:capturedRow.corpusSha256,runtimeSha256:captured.runtimeSha256,manifest:capturedRow.manifest});
 report.bootstrap=await bootstrapRelease(client,{releaseId:capturedRow.id,actor:'release-rehearsal',reason:'Captured production baseline in an empty disposable local database'});
 report.candidate=await stageRelease(client,{dictionary,corpus,corpusArchive:capturedRow.corpus_gzip,baseReleaseId:capturedRow.id,source:'enterprise-knowledge-release-preparation',manifest:{source:'Exact production archive with reviewed revision-9 knowledge; no relabeling',priorLocalCandidate:'c6eb172b-d8b8-4e1e-8cc9-32bb8190a7af'}});
 const staged=await loadRelease(client,report.candidate.releaseId),baseline=await loadRelease(client,capturedRow.id);
 assert.equal(staged.corpusSha256,capturedRow.corpusSha256);assert.equal(staged.dictionary.languageKnowledge.revision,9);
 report.candidateExport=await exportPair(staged,currentRuntime,'candidate-data');
 report.rollbackExport=await exportPair(baseline,captured.runtimeSha256,'rollback-data');
 assert.equal(await currentReleaseId(client),capturedRow.id);
 await client.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ai_language_runtime') THEN CREATE ROLE ai_language_runtime NOLOGIN; END IF; END $$");
 const tenantPolicy=await readFile(new URL('deploy/assistant/shared-language-tenants.sql',root),'utf8');
 await client.query(tenantPolicy);await client.query(tenantPolicy);
 for(const store of ['grocery','electronics','jewelry','pharmacy']){
  const role='rehearsal_'+store+'_'+suffix,password=randomBytes(32).toString('hex'),tenant=randomUUID();
  await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' IN ROLE ai_language_runtime`);
  const roleUrl=new URL(ownerUrl);roleUrl.username=role;roleUrl.password=password;
  roles.push({store,role,password,tenant,url:roleUrl.href});
  await client.query('INSERT INTO context.tenant_logins(role_name,tenant_id,store_name) VALUES($1,$2,$3)',[role,tenant,store]);
 }
 report.tenants=[];
 for(const role of roles){
  const tenantClient=new pg.Client({connectionString:role.url});await tenantClient.connect();
  try{
   assert.equal((await tenantClient.query('SELECT context.login_tenant() AS tenant')).rows[0].tenant,role.tenant);
   assert.equal((await tenantClient.query('SELECT fingerprint FROM release.dictionaries WHERE id=$1',[staged.releaseId])).rows[0].fingerprint,staged.fingerprint);
   await tenantClient.query("INSERT INTO context.sessions(tenant_id,session_id,revision,context,expires_at) VALUES($1,$2,1,$3,now()+interval '1 hour')",[role.tenant,randomUUID(),{store:role.store}]);
   assert.equal((await tenantClient.query('SELECT count(*) FROM context.sessions')).rows[0].count,'1');
   const other=roles.find(r=>r.store!==role.store)!;
   await assert.rejects(tenantClient.query("INSERT INTO context.sessions(tenant_id,session_id,revision,context,expires_at) VALUES($1,$2,1,'{}',now()+interval '1 hour')",[other.tenant,randomUUID()]),/row-level security/);
   for(const table of ['knowledge.bulk_imports','knowledge.bulk_chunks','knowledge.bulk_concepts','evaluation.cases']){
    const privileges=(await tenantClient.query('SELECT has_table_privilege(current_user,$1,\'SELECT\') AS read,has_table_privilege(current_user,$1,\'INSERT\') AS write',[table])).rows[0];
    assert.deepEqual(privileges,{read:false,write:false});
   }
   const blocked=await child(['scripts/deploy-start.ts','--verify-only'],{DATABASE_URL:role.url,CLE_SHARED_DATABASE:'true',CLE_DEPLOY_DATA_DIR:fileURLToPath(new URL('candidate-data/',output))},role.store+'-inactive-runtime-check.log');
   assert.notEqual(blocked,0,'An inactive candidate must not serve');
   report.tenants.push({store:role.store,knowledgeIdentity:true,sessionIsolation:true,stagingAccessDenied:true,unpromotedCandidateStartupDenied:true});
  }finally{await tenantClient.end();}
 }
 report.status='staged_inactive_awaiting_exact_evaluation';await write('release-rehearsal.json',report);
 console.log(JSON.stringify({status:report.status,candidateId:staged.releaseId,corpusCases:corpus.length}));
 if(globalThis.process.argv.includes('--prepare-only')){
  report.status='prepared_pending_exact_evaluation';
  report.promotion={performed:false,reason:'Preparation requested without duplicating the already running archived-corpus diagnostic'};
  report.rollback={performed:false,artifactsVerified:true,reason:'Candidate remains inactive; promotion and rollback require a passing exact evaluation'};
 }else{
 const evaluationExit=await child(['scripts/release.ts','evaluate','--release-id',staged.releaseId,'--report',fileURLToPath(new URL('exact-candidate-evaluation.json',output))],{DATABASE_URL:ownerUrl.href},'exact-candidate-evaluation.log');
 const evaluation=JSON.parse(await readFile(new URL('exact-candidate-evaluation.json',output),'utf8'));
 assert.equal(evaluation.runtimeSha256,currentRuntime);assert.equal(evaluation.artifactSha256,staged.artifactSha256);assert.equal(evaluation.corpusSha256,staged.corpusSha256);
 report.evaluation={evaluationId:evaluation.evaluationId,passed:evaluation.passed,count:evaluation.count,failureCount:evaluation.failureCount,wireFailureCount:evaluation.wireFailureCount,exitCode:evaluationExit};
 if(evaluation.passed){
  assert.equal(evaluationExit,0);
  report.promotion=await promoteRelease(client,{releaseId:staged.releaseId,evaluationId:evaluation.evaluationId,expectedActiveReleaseId:capturedRow.id,runtimeSha256:currentRuntime,rubricVersion:RELEASE_RUBRIC_VERSION,contractVersion:String(RELEASE_CONTRACT_VERSION),actor:'release-rehearsal',reason:'Exact passing evaluation in disposable database'});
  for(const role of roles){
   const exit=await child(['scripts/deploy-start.ts','--verify-only'],{DATABASE_URL:role.url,CLE_SHARED_DATABASE:'true',CLE_DEPLOY_DATA_DIR:fileURLToPath(new URL('candidate-data/',output))},role.store+'-promoted-runtime-check.log');
   assert.equal(exit,0);report.tenants.find((r:any)=>r.store===role.store).promotedRuntimeVerified=true;
  }
  report.rollback=await rollbackRelease(client,{releaseId:capturedRow.id,expectedActiveReleaseId:staged.releaseId,actor:'release-rehearsal',reason:'Return disposable database to exact captured production baseline'});
  report.status='passed_promote_and_rollback_rehearsal';
 }else{
  assert.notEqual(evaluationExit,0);report.status='blocked_by_exact_archived_corpus';
  report.promotion={performed:false,reason:'The unchanged release gate failed'};
  report.rollback={performed:false,artifactsVerified:true,reason:'Candidate was never promoted; exact candidate promote/rollback cannot be claimed'};
 }
 }
 assert.equal(await currentReleaseId(client),capturedRow.id);report.finalActiveReleaseId=capturedRow.id;
 assert.equal(await runtimeSha256(),currentRuntime,'Runtime changed during rehearsal');
}catch(error){report.status='rehearsal_error';report.error=error instanceof Error?error.message:String(error);throw error;}
finally{
 if(client)await client.end();
 if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
 for(const role of roles)await admin.query(`DROP ROLE "${role.role}"`);
 await admin.end();report.cleanedUp=true;report.completedAt=new Date().toISOString();await write('release-rehearsal.json',report);
}
console.log(JSON.stringify({status:report.status,evaluation:report.evaluation,cleanedUp:report.cleanedUp}));
