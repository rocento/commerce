/** Exact promotion/rollback rehearsal in a fresh disposable loopback database.
 * Run only after freezing the repaired runtime, candidate and reviewed corpus.
 * No production connection, gate override, benchmark rewriting or baseline
 * evaluation fabrication is permitted. Every evidence file is create-only.
 */
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {cp,mkdir,readFile,symlink,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {gunzipSync,gzipSync} from 'node:zlib';
const root=new URL('../../',import.meta.url);
const previous=new URL('output/enterprise-knowledge-release-prep-20261010/',root);
const repairRoot=new URL('output/enterprise-knowledge-release-repair-20261010/',root);
const runDirectory=process.env.REPAIR_RUN_DIRECTORY??'';
assert.ok(runDirectory===''||runDirectory==='final','Only the initial or final evidence directory is supported');
const repaired=runDirectory?new URL(runDirectory+'/',repairRoot):repairRoot;
const engine=new URL('engine/',repaired);
try{await symlink(fileURLToPath(new URL('commerce-assistant-platform/app/commerce_language_engine/node_modules/',root)),new URL('node_modules',engine),'dir');}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
const {importBaselineRelease,bootstrapRelease,stageRelease,loadRelease,currentReleaseId,promoteRelease,rollbackRelease}=await import(new URL('src/release-lifecycle.ts',engine).href);
const {runtimeSha256}=await import(new URL('src/runtime-identity.ts',engine).href);
const {prepareDatabaseExport}=await import(new URL('scripts/export-db-release.ts',engine).href);
const {readDeploymentRelease,RELEASE_CONTRACT_VERSION}=await import(new URL('scripts/deployment-release.ts',engine).href);
const {RELEASE_RUBRIC_VERSION}=await import(new URL('scripts/release-evaluation.ts',engine).href);
const benchmarkDirectory=process.env.REHEARSAL_BENCHMARK_DIRECTORY??'benchmark-v1';
assert.match(benchmarkDirectory,/^benchmark-v[1-9][0-9]*$/,'Benchmark directory must name a versioned local review');
const reviewedCorpus=new URL(benchmarkDirectory+'/reviewed-corpus.jsonl',repairRoot);
const output=new URL('rehearsal/',repaired);
const oldRuntime=new URL('output/enterprise-knowledge-phase0-20261010/engine/',root);
const oldScripts=new URL('output/production-language-contract-20261009/source/ai-service/app/commerce_language_engine/scripts/',root);
const rollbackRuntime=new URL('rollback-runtime/',output);
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const write=(name:string,value:unknown)=>writeFile(new URL(name,output),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const capturedBytes=await readFile(new URL('production-baseline.json',previous));
const captured=JSON.parse(capturedBytes.toString('utf8'));
const candidateBytes=await readFile(new URL('candidate.json',repaired));
const dictionary=JSON.parse(candidateBytes.toString('utf8'));
const corpusBytes=await readFile(reviewedCorpus);
const corpus=corpusBytes.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
const capturedRow={...captured.release,corpus_gzip:Buffer.from(captured.release.corpus_gzip,'base64')};
const originalCorpusBytes=gunzipSync(capturedRow.corpus_gzip);
const originalCorpus=originalCorpusBytes.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
assert.equal(sha(originalCorpusBytes),capturedRow.corpusSha256,'Captured baseline corpus changed');
assert.equal(dictionary.languageKnowledge?.revision,10,'Rehearsal requires reviewed knowledge revision 10');
assert.ok(corpus.length>0,'The reviewed release corpus must be nonempty');
assert.notEqual(sha(corpusBytes),capturedRow.corpusSha256,'The new release must use the reviewed corpus, not replace the captured baseline');
const currentRuntime=await runtimeSha256(engine);
assert.equal(await runtimeSha256(oldRuntime),captured.runtimeSha256,'Frozen rollback runtime is not the captured production runtime');
assert.equal(sha(await readFile(new URL('package-lock.json',oldRuntime))),sha(await readFile(new URL('package-lock.json',engine))),'Rollback dependencies need a separate install when locks differ');
const connection=new URL(process.env.PHASE3_TEST_DATABASE_URL??'');
assert.equal(connection.hostname,'127.0.0.1');assert.equal(connection.port,'57433');assert.equal(connection.pathname,'/postgres');
assert.equal(connection.protocol,'postgresql:');
const pg=createRequire(new URL('package.json',engine))('pg');
const suffix=randomBytes(8).toString('hex'),database='repaired_release_rehearsal_'+suffix;
const ownerUrl=new URL(connection);ownerUrl.pathname='/'+database;
const admin=new pg.Client({connectionString:connection.href});
const roles:{store:string;role:string;tenant:string;password:string;url:string}[]=[];
let client:any,created=false,createdRuntimeGroup=false,adminConnected=false,failure:unknown;
const report:any={startedAt:new Date().toISOString(),scope:'Disposable database only; no production or main local database mutation',database,
 baseReleaseId:capturedRow.id,baseRuntimeSha256:captured.runtimeSha256,runtimeSha256:currentRuntime,
 inputs:{capturedBaselineSha256:sha(capturedBytes),candidateFileSha256:sha(candidateBytes),benchmarkDirectory,reviewedCorpusSha256:sha(corpusBytes),originalCorpusSha256:sha(originalCorpusBytes),rehearsalScriptSha256:sha(await readFile(fileURLToPath(import.meta.url)))},
 originalCorpusCases:originalCorpus.length,reviewedCorpusCases:corpus.length,knowledgeRevision:10,
 productionChanged:false,mainLocalDatabaseChanged:false,productionActivated:false,
 gate:{rubricVersion:RELEASE_RUBRIC_VERSION,contractVersion:RELEASE_CONTRACT_VERSION,unchanged:true},tenants:[]};

async function child(args:string[],env:Record<string,string>,logName:string,cwd=engine){
 const log=createWriteStream(new URL(logName,output),{flags:'wx',mode:0o600});
 return await new Promise<number>((resolve,reject)=>{
  let finished=false;
  const finish=(error:Error|null,code=1)=>{if(finished)return;finished=true;log.end(()=>error?reject(error):resolve(code));};
  const task=spawn(process.execPath,args,{cwd:fileURLToPath(cwd),env:{...process.env,CLE_ALLOW_LEGACY_BASELINE_TRANSITION:'false',...env},stdio:['ignore','pipe','pipe']});
  log.on('error',error=>{task.kill('SIGTERM');finish(error);});
  task.stdout.pipe(log,{end:false});task.stderr.pipe(log,{end:false});
  task.on('error',error=>finish(error));task.on('close',code=>finish(null,code??1));
 });
}
async function exportPair(row:any,hash:string,directory:string){
 const prepared=prepareDatabaseExport(row,hash),destination=new URL(directory+'/',output);
 await mkdir(destination,{mode:0o700});
 await writeFile(new URL('compiled.json',destination),JSON.stringify(prepared.artifact),{flag:'wx',mode:0o600});
 await writeFile(new URL('deployment-release.json.gz',destination),prepared.bundle,{flag:'wx',mode:0o600});
 const checked=await readDeploymentRelease(destination,{verifyRuntime:hash===currentRuntime});
 assert.equal(checked.release?.payload.format,2);
 const identity=(checked.release!.payload as any).identity;assert.equal(identity.runtimeSha256,hash);
 return {directory,identity,bundleSha256:sha(prepared.bundle),compiledSha256:sha(JSON.stringify(prepared.artifact)),corpusCases:prepared.corpus.length};
}
async function runtimeCheck(role:typeof roles[number],phase:string,candidate:boolean,expectedSuccess:boolean){
 const directory=candidate?'candidate-data/':'rollback-data/';
 const log=`${role.store}-${phase}-${candidate?'candidate':'rollback'}-startup.log`;
 const exitCode=await child(['scripts/deploy-start.ts','--verify-only'],{DATABASE_URL:role.url,CLE_SHARED_DATABASE:'true',CLE_DEPLOY_DATA_DIR:fileURLToPath(new URL(directory,output))},log,candidate?engine:rollbackRuntime);
 const body=await readFile(new URL(log,output));
 if(expectedSuccess){assert.equal(exitCode,0,role.store+' '+phase+' '+directory+' startup failed');assert.match(body.toString('utf8'),/runtime release verified; database unchanged/);}
 else {assert.notEqual(exitCode,0,'An inactive or stale runtime must not serve');assert.match(body.toString('utf8'),/Active language release differs|Active release UUID differs|Active language artifact differs/,'Denial must be caused by the inactive release, not a broken harness');}
 return {exitCode,expectedSuccess,verified:true,log,logSha256:sha(body)};
}

// A run cannot overwrite either an earlier failure or an earlier success.
await mkdir(output,{mode:0o700});
try{
 await cp(oldRuntime,rollbackRuntime,{recursive:true,errorOnExist:true,force:false});
 await mkdir(new URL('scripts/',rollbackRuntime),{recursive:true});
 report.rollbackStartupScripts={};
 for(const name of ['deploy-start.ts','shared-runtime.ts','deployment-release.ts','release-evaluation.ts']){
  const bytes=await readFile(new URL(name,oldScripts));
  await writeFile(new URL('scripts/'+name,rollbackRuntime),bytes,{flag:'wx'});
  report.rollbackStartupScripts[name]={source:'captured production-language-contract-20261009',sha256:sha(bytes)};
 }
 await symlink(fileURLToPath(new URL('node_modules/',engine)),new URL('node_modules',rollbackRuntime),'dir');
 assert.equal(await runtimeSha256(rollbackRuntime),captured.runtimeSha256);
 report.rollbackDependencies={sameLockSha256:sha(await readFile(new URL('package-lock.json',oldRuntime))),source:'Current installed dependencies through a local symlink; the two frozen lockfiles match exactly'};
 await admin.connect();adminConnected=true;
 await admin.query(`CREATE DATABASE "${database}"`);created=true;
 process.env.DATABASE_URL=ownerUrl.href;
 const db=await import(new URL('src/database.ts',engine).href);
 try{await db.migrate();}finally{await db.closeDb();}
 client=new pg.Client({connectionString:ownerUrl.href});await client.connect();
 report.migrations=(await client.query('SELECT filename,sha256 FROM public.schema_migrations ORDER BY filename')).rows;
 const applied=new Map(report.migrations.map((row:any)=>[row.filename,row.sha256]));
 for(const migration of captured.migrations)assert.equal(applied.get(migration.filename),migration.sha256,'Captured production migration checksum differs: '+migration.filename);
 assert.equal(applied.get('032_delivery_question_knowledge.sql'),sha(await readFile(new URL('migrations/032_delivery_question_knowledge.sql',engine))),'Delivery question migration was not applied exactly');
 report.importedBaseline=await importBaselineRelease(client,{releaseId:capturedRow.id,dictionary:capturedRow.artifact,corpus:originalCorpus,corpusArchive:capturedRow.corpus_gzip,baseReleaseId:capturedRow.base_release_id??null,artifactSha256:capturedRow.artifactSha256,corpusSha256:capturedRow.corpusSha256,runtimeSha256:captured.runtimeSha256,manifest:capturedRow.manifest});
 report.bootstrap=await bootstrapRelease(client,{releaseId:capturedRow.id,actor:'repaired-release-rehearsal',reason:'Captured production baseline in an empty disposable local database'});
 report.candidate=await stageRelease(client,{dictionary,corpus,corpusArchive:gzipSync(corpusBytes),baseReleaseId:capturedRow.id,source:'enterprise-knowledge-release-repair',manifest:{source:'Reviewed revision-10 knowledge and versioned benchmark corrections',originalCorpusSha256:sha(originalCorpusBytes),reviewedCorpusSha256:sha(corpusBytes),candidateFileSha256:sha(candidateBytes)}});
 const staged=await loadRelease(client,report.candidate.releaseId),baseline=await loadRelease(client,capturedRow.id);
 assert.equal(staged.corpusSha256,sha(corpusBytes));assert.equal(baseline.corpusSha256,sha(originalCorpusBytes));
 assert.equal(staged.dictionary.languageKnowledge.revision,10);
 report.deliveryQuestionProjection=(await client.query("SELECT q.code,q.intent,jsonb_array_length(q.templates) AS templates,g.record->>'runtime' AS runtime,g.record->>'status' AS review_status FROM knowledge.question_rules q JOIN knowledge.packs p ON p.sha256=q.pack_sha256 JOIN knowledge.rule_governance g ON g.pack_sha256=q.pack_sha256 AND g.family='question' AND g.rule_code=q.code WHERE p.code=$1 AND p.revision=10 AND q.intent='DELIVERY_DATE' ORDER BY q.code",[dictionary.languageKnowledge.id])).rows;
 assert.equal(report.deliveryQuestionProjection.length,dictionary.languageKnowledge.questionRules.filter((row:any)=>row.intent==='DELIVERY_DATE').length);
 assert.ok(report.deliveryQuestionProjection.length>0);
 for(const row of report.deliveryQuestionProjection){assert.equal(row.runtime,'knowledge-delivery-questions-v4');assert.equal(row.review_status,'reviewed');}
 report.candidateExport=await exportPair(staged,currentRuntime,'candidate-data');
 report.rollbackExport=await exportPair(baseline,captured.runtimeSha256,'rollback-data');
 assert.equal(await currentReleaseId(client),capturedRow.id);
 if(!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='ai_language_runtime'")).rowCount){await admin.query('CREATE ROLE ai_language_runtime NOLOGIN');createdRuntimeGroup=true;}
 const tenantPolicy=await readFile(new URL('deploy/assistant/shared-language-tenants.sql',root),'utf8');
 report.tenantPolicySha256=sha(tenantPolicy);await client.query(tenantPolicy);await client.query(tenantPolicy);
 for(const store of ['grocery','electronics','jewelry','pharmacy']){
  const role='repair_'+store+'_'+suffix,password=randomBytes(32).toString('hex'),tenant=randomUUID();
  const roleUrl=new URL(ownerUrl);roleUrl.username=role;roleUrl.password=password;
  await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' IN ROLE ai_language_runtime`);
  roles.push({store,role,password,tenant,url:roleUrl.href});
  await client.query('INSERT INTO context.tenant_logins(role_name,tenant_id,store_name) VALUES($1,$2,$3)',[role,tenant,store]);
 }
 for(const role of roles){
  const tenantClient=new pg.Client({connectionString:role.url});await tenantClient.connect();
  try{
   assert.equal((await tenantClient.query('SELECT context.login_tenant() AS tenant')).rows[0].tenant,role.tenant);
   assert.equal((await tenantClient.query('SELECT fingerprint FROM release.dictionaries WHERE id=$1',[staged.releaseId])).rows[0].fingerprint,staged.fingerprint);
   await tenantClient.query("INSERT INTO context.sessions(tenant_id,session_id,revision,context,expires_at) VALUES($1,$2,1,$3,now()+interval '1 hour')",[role.tenant,randomUUID(),{store:role.store}]);
   assert.equal((await tenantClient.query('SELECT count(*) FROM context.sessions')).rows[0].count,'1');
   const other=roles.find(row=>row.store!==role.store)!;
   await assert.rejects(tenantClient.query("INSERT INTO context.sessions(tenant_id,session_id,revision,context,expires_at) VALUES($1,$2,1,'{}',now()+interval '1 hour')",[other.tenant,randomUUID()]),/row-level security/);
   for(const table of ['knowledge.bulk_imports','knowledge.bulk_chunks','knowledge.bulk_concepts','evaluation.cases']){
    const privileges=(await tenantClient.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS write",[table])).rows[0];
    assert.deepEqual(privileges,{read:false,write:false});
   }
  }finally{await tenantClient.end();}
  report.tenants.push({store:role.store,knowledgeIdentity:true,sessionIsolation:true,stagingAccessDenied:true,
   inactiveCandidate:await runtimeCheck(role,'before-promotion',true,false),
   initialBaseline:await runtimeCheck(role,'before-promotion',false,true)});
 }
 report.status='staged_inactive_awaiting_exact_evaluation';await write('001-prepared.json',report);
 console.log(JSON.stringify({status:report.status,candidateId:staged.releaseId,corpusCases:corpus.length}));
 if(process.argv.includes('--prepare-only')){
  report.status='prepared_pending_exact_evaluation';report.promotion={performed:false};report.rollback={performed:false,artifactsVerified:true};
 }else{
  const evaluationExit=await child(['scripts/release.ts','evaluate','--release-id',staged.releaseId,'--report',fileURLToPath(new URL('exact-candidate-evaluation.json',output))],{DATABASE_URL:ownerUrl.href},'exact-candidate-evaluation.log');
  const evaluationBytes=await readFile(new URL('exact-candidate-evaluation.json',output)),evaluation=JSON.parse(evaluationBytes.toString('utf8'));
  assert.equal(evaluation.runtimeSha256,currentRuntime);assert.equal(evaluation.artifactSha256,staged.artifactSha256);assert.equal(evaluation.corpusSha256,staged.corpusSha256);
  assert.equal(evaluation.count,corpus.length);assert.equal(evaluation.rubricVersion,RELEASE_RUBRIC_VERSION);
  report.evaluation={evaluationId:evaluation.evaluationId,passed:evaluation.passed,count:evaluation.count,failureCount:evaluation.failureCount,wireFailureCount:evaluation.wireFailureCount,exitCode:evaluationExit,
   runtimeSha256:evaluation.runtimeSha256,artifactSha256:evaluation.artifactSha256,corpusSha256:evaluation.corpusSha256,sourceReportSha256:sha(evaluationBytes)};
  await write('002-evaluated.json',report);
  const promotion={releaseId:staged.releaseId,evaluationId:evaluation.evaluationId,expectedActiveReleaseId:capturedRow.id,runtimeSha256:currentRuntime,rubricVersion:RELEASE_RUBRIC_VERSION,contractVersion:String(RELEASE_CONTRACT_VERSION),actor:'repaired-release-rehearsal',reason:'Exact passing evaluation in disposable database'};
  if(evaluation.passed){
   assert.equal(evaluationExit,0);assert.equal(evaluation.failureCount,0);assert.equal(evaluation.wireFailureCount,0);
   report.promotion={performed:true,...await promoteRelease(client,promotion)};
   assert.equal(await currentReleaseId(client),staged.releaseId);
   for(const role of roles){const row=report.tenants.find((row:any)=>row.store===role.store);row.promotedCandidate=await runtimeCheck(role,'promoted',true,true);}
   await write('003-promoted.json',report);
   report.rollback={performed:true,...await rollbackRelease(client,{releaseId:capturedRow.id,expectedActiveReleaseId:staged.releaseId,actor:'repaired-release-rehearsal',reason:'Restore exact captured production baseline and runtime in disposable database'})};
   assert.equal(await currentReleaseId(client),capturedRow.id);
   for(const role of roles){
    const row=report.tenants.find((row:any)=>row.store===role.store);
    row.restoredBaseline=await runtimeCheck(role,'after-rollback',false,true);
    row.staleCandidate=await runtimeCheck(role,'after-rollback',true,false);
   }
   report.status='passed_exact_gate_promote_and_rollback_rehearsal';await write('004-rolled-back.json',report);
  }else{
   assert.notEqual(evaluationExit,0);
   await assert.rejects(promoteRelease(client,promotion),/requires passing evaluation/);
   report.status='blocked_by_exact_reviewed_corpus';report.promotion={performed:false,rejectionVerified:true};
   report.rollback={performed:false,artifactsVerified:true,reason:'Failed candidate remains inactive'};
  }
 }
 assert.equal(await currentReleaseId(client),capturedRow.id);report.finalActiveReleaseId=capturedRow.id;
 report.activations=(await client.query('SELECT channel,release_id,previous_release_id,evaluation_id,actor,reason,operation FROM release.activations ORDER BY id')).rows;
 assert.equal(await runtimeSha256(engine),currentRuntime,'Runtime changed during rehearsal');
 assert.equal(await runtimeSha256(rollbackRuntime),captured.runtimeSha256,'Rollback runtime changed during rehearsal');
 assert.equal(sha(await readFile(new URL('candidate.json',repaired))),report.inputs.candidateFileSha256,'Candidate source changed during rehearsal');
 assert.equal(sha(await readFile(reviewedCorpus)),report.inputs.reviewedCorpusSha256,'Reviewed corpus changed during rehearsal');
}catch(error){failure=error;report.status='rehearsal_error';report.error=error instanceof Error?error.message:String(error);}
finally{
 const cleanupErrors:string[]=[];
 if(client)try{await client.end();}catch{cleanupErrors.push('client connection cleanup failed');}
 if(adminConnected){
  if(created)try{await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);}catch{cleanupErrors.push('disposable database cleanup failed');}
  for(const role of roles)try{await admin.query(`DROP ROLE "${role.role}"`);}catch{cleanupErrors.push('disposable role cleanup failed: '+role.role);}
  if(createdRuntimeGroup)try{await admin.query('DROP ROLE ai_language_runtime');}catch{cleanupErrors.push('new runtime group cleanup failed');}
  try{await admin.end();}catch{cleanupErrors.push('administrator connection cleanup failed');}
 }
 report.cleanedUp=cleanupErrors.length===0;report.cleanupErrors=cleanupErrors;report.completedAt=new Date().toISOString();
 if(cleanupErrors.length){report.status='cleanup_error';failure??=new Error(cleanupErrors.join('; '));}
 await write('release-rehearsal.json',report);
}
console.log(JSON.stringify({status:report.status,evaluation:report.evaluation,cleanedUp:report.cleanedUp}));
if(failure)throw failure;
if(report.status==='blocked_by_exact_reviewed_corpus')process.exitCode=1;
