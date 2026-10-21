import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {validateDataset,importDataset,loadDataset,evaluateReviewedDataset,captureFeedback,reviewFeedback} from '../src/reviewed-evaluation.ts';
import {stageRelease,recordReleaseEvaluation,loadRelease} from '../src/release-lifecycle.ts';
const url=process.env.LANGUAGE_RELEASE_TEST_DATABASE_URL;
const dictionary=(recognitionFixture(JSON.parse(await readFile(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const good={key:'search',text:'find red shoes',language:'en',industry:'CORE',expected:{intent:'PRODUCT_SEARCH',status:'RESOLVED'}};
const input={code:'reviewed-smoke',revision:1,reviewedBy:'test-reviewer',cases:[good]};
test('reviewed validation rejects typos, unsupported languages, duplicate keys and unbounded input',()=>{
 assert.equal(validateDataset(input).cases.length,1);
 for(const value of [{...input,cases:[]},{...input,cases:[good,good]},{...input,revision:0},{...input,cases:[{...good,language:'ar'}]},{...input,cases:[{...good,expected:{...good.expected,entites:{}}}]},{...input,cases:[{...good,text:'x'.repeat(4001)}]}])assert.throws(()=>validateDataset(value));
});
test('cleanup and reviewed feedback/evaluation workflow on PostgreSQL',{skip:!url,timeout:60000},async t=>{
 const name='quality_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:url});await admin.connect();let c:pg.Client|undefined;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);const target=new URL(url!);target.pathname='/'+name;c=new pg.Client({connectionString:target.href});await c.connect();const db=c;
  const dir=new URL('../migrations/',import.meta.url),files=(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort();
  for(const file of files.filter(f=>f<'025'))await db.query(await readFile(new URL(file,dir),'utf8'));
  await db.query("INSERT INTO entity.types(code) VALUES('LEGACY_TEST')");
  await db.query("INSERT INTO entity_legacy.aliases(entity_type_id,alias,normalized_alias,canonical_value) SELECT id,'test','test','test' FROM entity.types WHERE code='LEGACY_TEST'");
  await assert.rejects(db.query(await readFile(new URL('025_retire_legacy_entities.sql',dir),'utf8')),/contain records/);await db.query('ROLLBACK');
  assert.equal((await db.query('SELECT count(*) FROM entity_legacy.aliases')).rows[0].count,'1');await db.query('DELETE FROM entity_legacy.aliases');
  await db.query("INSERT INTO evaluation.results(dictionary_version,metrics) VALUES(1,'{\"historical\":true}')");
  for(const file of files.filter(f=>f>='025'))await db.query(await readFile(new URL(file,dir),'utf8'));
  assert.equal((await db.query("SELECT to_regclass('entity_legacy.terms') AS t")).rows[0].t,null);
  const release=await stageRelease(db,{dictionary,corpus:[{text:good.text,intent:'PRODUCT_SEARCH',difficulty:'easy'}],baseReleaseId:null,source:'test'});
  const frozen=await loadRelease(db,release.releaseId),runtimeSha256='a'.repeat(64);
  const record=(reviewed:any,passed=reviewed.passed)=>recordReleaseEvaluation(db,{releaseId:release.releaseId,artifactSha256:frozen.artifactSha256,corpusSha256:frozen.corpusSha256,runtimeSha256,rubricVersion:'test-v1',contractVersion:'2',passed,report:{test:true},reviewed});
  await t.test('immutable idempotent datasets, exact case membership and single-source reporting',async()=>{
   const imported=await importDataset(db,input),dataset=await loadDataset(db,imported.datasetId);
   assert.equal((await importDataset(db,input)).imported,false);
   await assert.rejects(importDataset(db,{...input,reviewedBy:'changed'}),/different content/);
   await assert.rejects(db.query('UPDATE evaluation.datasets SET reviewed_by=\'changed\' WHERE id=$1',[dataset.id]),/immutable/);
   await assert.rejects(db.query('INSERT INTO evaluation.cases(dataset_id,case_key,definition) VALUES($1,\'late\',$2)',[dataset.id,good]),/atomically/);
   const result=evaluateReviewedDataset(dictionary,dataset,{releaseId:release.releaseId,runtimeSha256});assert.equal(result.passed,true,JSON.stringify(result));
   const id=await record(result);
   assert.equal((await db.query('SELECT count(*) FROM evaluation.case_results WHERE evaluation_id=$1',[id])).rows[0].count,'1');
   assert.equal((await db.query('SELECT count(*) FROM evaluation.legacy_results')).rows[0].count,'1');
   assert.equal((await db.query('SELECT count(*) FROM evaluation.results')).rows[0].count,'2');
   await db.query(`INSERT INTO evaluation.results(dictionary_version,metrics,release_id) SELECT d.dictionary_version,e.report||jsonb_build_object('releaseEvidenceId',e.id,'runtimeSha256',e.runtime_sha256,'rubricVersion',e.rubric_version,'passed',e.passed),e.release_id FROM release.evaluations e JOIN release.dictionaries d ON d.id=e.release_id WHERE e.id=$1`,[id]);
   assert.equal((await db.query('SELECT count(*) FROM evaluation.results')).rows[0].count,'2');
   await assert.rejects(db.query("INSERT INTO evaluation.results(dictionary_version,metrics) VALUES(1,'{}')"),/authoritative/);
   await assert.rejects(db.query('UPDATE evaluation.case_results SET passed=false WHERE evaluation_id=$1',[id]),/immutable/);
   const before=(await db.query('SELECT count(*) FROM release.evaluations')).rows[0].count;
   await assert.rejects(record({...result,results:[]}),/membership/);
   assert.equal((await db.query('SELECT count(*) FROM release.evaluations')).rows[0].count,before);
  });
  await t.test('failed reviewed expectations cannot produce passing release evidence',async()=>{
   const imported=await importDataset(db,{...input,revision:2,cases:[{...good,expected:{...good.expected,intent:'CART_ADD'}}]});
   const result=evaluateReviewedDataset(dictionary,await loadDataset(db,imported.datasetId),{releaseId:release.releaseId,runtimeSha256});
   assert.equal(result.failureCount,1);assert.deepEqual(result.results[0].mismatches,['intent']);
   await assert.rejects(record(result,true),/Failing reviewed/);await record(result,false);
  });
  await t.test('feedback needs an immutable approved correction before dataset import',async()=>{
   const feedback=await captureFeedback(db,{tenantId:randomUUID(),requestId:randomUUID(),releaseId:release.releaseId,engineVersion:runtimeSha256,observedCase:good,predictedIntent:null,status:'UNKNOWN'});
   const candidate={...input,code:'feedback',cases:[{...good,sourceFeedbackId:feedback.feedbackId}]};
   await assert.rejects(importDataset(db,candidate),/foreign key|approved/);
   await reviewFeedback(db,{feedbackId:feedback.feedbackId,decision:'approved',reviewer:'test',reason:'synthetic correction',correctedCase:good});
   await assert.rejects(reviewFeedback(db,{feedbackId:feedback.feedbackId,decision:'rejected',reviewer:'other',reason:'overwrite'}),/duplicate/);
   await importDataset(db,candidate);
   await assert.rejects(importDataset(db,{...candidate,revision:2,cases:[{...candidate.cases[0],text:'different'}]}),/approved feedback/);
   assert.equal((await db.query('SELECT review_status FROM resolution.feedback_queue WHERE id=$1',[feedback.feedbackId])).rows[0].review_status,'approved');
  });
  await t.test('shared grants exclude customer feedback and reviewed case contents',async()=>{
   await db.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_language_runtime') THEN CREATE ROLE ai_language_runtime NOLOGIN; END IF; END $$`);
   await db.query(await readFile(new URL('../../../../deploy/assistant/shared-language-tenants.sql',import.meta.url),'utf8'));
   const grants=(await db.query("SELECT has_table_privilege('ai_language_runtime','resolution.feedback','SELECT') AS feedback,has_table_privilege('ai_language_runtime','evaluation.cases','SELECT') AS cases,has_table_privilege('ai_language_runtime','release.production_status','SELECT') AS status")).rows[0];assert.deepEqual(grants,{feedback:false,cases:false,status:true});
  });
 }finally{await c?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();}
});
