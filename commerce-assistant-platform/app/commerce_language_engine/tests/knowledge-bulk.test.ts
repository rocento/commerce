import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {canonicalKnowledge,knowledgeHash} from '../src/language-knowledge.ts';
import {prepareBulkBundle,parseBulkManifest,decodeChunk,readBulkManifest,boundedRead,uploadBulkBundle,inspectBulkImport,finalizeBulkImport,cancelBulkImport} from '../src/knowledge-bulk.ts';
import {stageRelease,bootstrapRelease} from '../src/release-lifecycle.ts';
const pack={schemaVersion:1,id:'bulk-fixture',revision:1,language:'en',source:'Disposable integration fixture',concepts:[{id:'activity.one',kind:'activity',canonical:'soldering',aliases:['soldering circuits']},{id:'activity.two',kind:'activity',canonical:'knitting',aliases:[]}],rules:[{id:'activity.for',marker:'for',targetKind:'activity',relation:'intended_use',scope:'product',priority:80}]};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

test('bundle preparation validates immutable identity, bounded UTF-8 chunks and content',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'knowledge-bulk-'));
 try{
  const bundle=join(dir,'bundle'),manifest=await prepareBulkBundle(pack,bundle,1);
  assert.equal(manifest.chunks.length,2);assert.equal(manifest.packSha256,knowledgeHash(canonicalKnowledge(pack)));assert.deepEqual(await readBulkManifest(bundle),manifest);
  await assert.rejects(prepareBulkBundle(pack,bundle),/EEXIST/);
  const bytes=await readFile(join(bundle,manifest.chunks[0].file));assert.equal(decodeChunk(bytes,manifest.chunks[0])[0].id,'activity.one');
  assert.throws(()=>decodeChunk(Buffer.from('corrupt'),manifest.chunks[0]),/checksum/);
  assert.throws(()=>parseBulkManifest({...manifest,concepts:10}),/count/);
  assert.throws(()=>parseBulkManifest({...manifest,extra:true}),/manifest/);
  assert.throws(()=>parseBulkManifest({...manifest,chunks:[{...manifest.chunks[0],file:'../secret'}]}),/descriptor/);
  assert.throws(()=>parseBulkManifest({...manifest,header:{...manifest.header,concepts:[]}}),/manifest/);
  await assert.rejects(boundedRead(join(bundle,manifest.chunks[0].file),2),/limit/);
  const duplicate=Buffer.concat([bytes,bytes]);assert.throws(()=>decodeChunk(duplicate,{...manifest.chunks[0],sha256:sha(duplicate),records:2,bytes:duplicate.length}),/duplicate/);
  const noNewline=bytes.subarray(0,-1);assert.throws(()=>decodeChunk(noNewline,{...manifest.chunks[0],sha256:sha(noNewline),bytes:noNewline.length}),/newline/);
  const invalidUtf8=Buffer.from([0xff,10]);assert.throws(()=>decodeChunk(invalidUtf8,{...manifest.chunks[0],sha256:sha(invalidUtf8),bytes:2}),/UTF-8/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('real PostgreSQL upload resumes, fails closed and recovers candidate commit',{skip:!process.env.LANGUAGE_KNOWLEDGE_TEST_DATABASE_URL,timeout:120000},async t=>{
 const admin=new pg.Client({connectionString:process.env.LANGUAGE_KNOWLEDGE_TEST_DATABASE_URL}),database='bulk_'+randomUUID().replaceAll('-','');
 const dir=await mkdtemp(join(tmpdir(),'knowledge-bulk-db-'));let client:pg.Client|undefined;
 await admin.connect();
 try{
  await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(process.env.LANGUAGE_KNOWLEDGE_TEST_DATABASE_URL!);url.pathname='/'+database;client=new pg.Client({connectionString:url.href});await client.connect();const c=client;
  const migrations=new URL('../migrations/',import.meta.url);
  for(const f of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await c.query(await readFile(new URL(f,migrations),'utf8'));
  const raw=(recognitionFixture(JSON.parse(await readFile(new URL('../data/compiled.json',import.meta.url),'utf8'))));
  const {languageKnowledge:_pack,generationFingerprint:_fp,corpus:_corpus,...content}=raw;
  const base={...content,corpus:[],generationFingerprint:knowledgeHash(content)},baseline=await stageRelease(c,{dictionary:base,corpus:[{text:'baseline fixture'} as any],baseReleaseId:null,source:'bulk-test'});
  await bootstrapRelease(c,{releaseId:baseline.releaseId,actor:'test',reason:'disposable database only'});
  const current=(await c.query('SELECT fingerprint FROM release.dictionaries WHERE id=$1',[baseline.releaseId])).rows[0].fingerprint;
  const bundle=join(dir,'bundle'),manifest=await prepareBulkBundle(pack,bundle,1);
  let id:string;
  await t.test('pause after one batch; incomplete finalization cannot publish',async()=>{
   const partial=await uploadBulkBundle(c,bundle,current,1);id=partial.id;assert.equal(partial.completedChunks,1);assert.deepEqual(partial.missingChunks,[1]);
   await assert.rejects(finalizeBulkImport(c,id),/incomplete/);assert.equal((await c.query('SELECT count(*) FROM knowledge.packs')).rows[0].count,'0');
  });
  await t.test('corrupt remaining chunk preserves the durable checkpoint',async()=>{
   const path=join(bundle,manifest.chunks[1].file),original=await readFile(path);await writeFile(path,'bad');
   await assert.rejects(uploadBulkBundle(c,bundle,current),/checksum/);assert.equal((await inspectBulkImport(c,id!)).completedChunks,1);await writeFile(path,original);
  });
  await t.test('resuming from a new connection imports only missing batches',async()=>{
   await c.end();client=new pg.Client({connectionString:url.href});await client.connect();
   const complete=await uploadBulkBundle(client,bundle,current);assert.equal(complete.id,id!);assert.equal(complete.completedConcepts,2);
   assert.deepEqual(await uploadBulkBundle(client,bundle,current),complete);
  });
  await t.test('a concurrent operator cannot mutate the same upload',async()=>{
   const other=new pg.Client({connectionString:url.href});await other.connect();
   try{await other.query('SELECT pg_advisory_lock(57440,$1)',[Number.parseInt(id!.slice(0,8),16)|0]);await assert.rejects(uploadBulkBundle(client!,bundle,current),/busy/);}finally{await other.end();}
  });
  await t.test('candidate commit followed by lost checkpoint is recoverable and never activates',async()=>{
   await client!.query("CREATE FUNCTION knowledge.fail_final_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='imported' THEN RAISE EXCEPTION 'checkpoint interrupted'; END IF; RETURN NEW; END $$");
   await client!.query('CREATE TRIGGER fail_final BEFORE UPDATE ON knowledge.bulk_imports FOR EACH ROW EXECUTE FUNCTION knowledge.fail_final_checkpoint()');
   await assert.rejects(finalizeBulkImport(client!,id!),/checkpoint interrupted/);
   assert.equal((await client!.query('SELECT count(*) FROM knowledge.packs')).rows[0].count,'1');
   await client!.query('DROP TRIGGER fail_final ON knowledge.bulk_imports');
   const complete=await finalizeBulkImport(client!,id!);assert.equal(complete.status,'imported');assert.ok(complete.releaseId);assert.equal(complete.activated,false);
   assert.deepEqual(await finalizeBulkImport(client!,id!),complete);assert.equal((await client!.query('SELECT count(*) FROM knowledge.packs')).rows[0].count,'1');
   assert.equal((await client!.query("SELECT release_id FROM release.channels WHERE channel='production'")).rows[0].release_id,baseline.releaseId);
   await assert.rejects(cancelBulkImport(client!,id!),/cannot be cancelled/);
   for(const table of ['bulk_chunks','bulk_concepts'])await assert.rejects(client!.query(`DELETE FROM knowledge.${table} WHERE import_id=$1`,[id]),/immutable/);
   await assert.rejects(client!.query("UPDATE knowledge.bulk_imports SET expected_fingerprint=$2 WHERE id=$1",[id,'a'.repeat(64)]),/immutable/);
  });
  await t.test('stale base rejects finalization and cancellation is durable',async()=>{
   const stale=await uploadBulkBundle(client!,bundle,'f'.repeat(64));await assert.rejects(finalizeBulkImport(client!,stale.id),/fingerprint/);
   assert.equal((await cancelBulkImport(client!,stale.id)).status,'cancelled');await assert.rejects(uploadBulkBundle(client!,bundle,'f'.repeat(64)),/cancelled/);await assert.rejects(finalizeBulkImport(client!,stale.id),/cancelled/);
  });
  await t.test('duplicate concepts across batches roll back only the failing batch',async()=>{
   const duplicate=structuredClone(manifest),first=await readFile(join(bundle,duplicate.chunks[0].file));
   duplicate.chunks[1]={...duplicate.chunks[0],file:duplicate.chunks[1].file};
   const bad=join(dir,'bad');await (await import('node:fs/promises')).mkdir(bad);await writeFile(join(bad,'manifest.json'),JSON.stringify(duplicate));for(const ch of duplicate.chunks)await writeFile(join(bad,ch.file),first);
   await assert.rejects(uploadBulkBundle(client!,bad,current),/duplicate key/);
   const badId=knowledgeHash({manifest:duplicate,expectedFingerprint:current});assert.equal((await inspectBulkImport(client!,badId)).completedChunks,1);
   await cancelBulkImport(client!,badId);
  });
  await t.test('runtime role cannot read or write upload staging after tenant policy reapply',async()=>{
   await client!.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ai_language_runtime') THEN CREATE ROLE ai_language_runtime NOLOGIN; END IF; END $$");
   const policy=await readFile(new URL('../../../../deploy/assistant/shared-language-tenants.sql',import.meta.url),'utf8');
   await client!.query(policy);await client!.query(policy);
   for(const table of ['bulk_imports','bulk_chunks','bulk_concepts']){
    const r=(await client!.query("SELECT has_table_privilege('ai_language_runtime',$1,'SELECT') AS r,has_table_privilege('ai_language_runtime',$1,'INSERT') AS w",['knowledge.'+table])).rows[0];assert.deepEqual(r,{r:false,w:false});
   }
  });
 }finally{if(client)await client.end();await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.end();await rm(dir,{recursive:true,force:true});}
});
