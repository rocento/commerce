import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
/** Every integration test owns a disposable PostgreSQL database. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import pg from 'pg';
import {importBaselineRelease,releaseContentHashes,bootstrapRelease,currentReleaseId,createReleaseDraft,freezeReleaseDraft,loadRelease,promoteRelease,recordReleaseEvaluation,reviseReleaseDraft,rollbackRelease,stageRelease} from '../src/release-lifecycle.ts';
import {importVocabulary} from '../src/vocabulary-store.ts';
const url=process.env.LANGUAGE_RELEASE_TEST_DATABASE_URL;
const dictionary=(recognitionFixture(JSON.parse(await readFile(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const corpus=[{text:'find red shoes',intent:'SEARCH_PRODUCTS',difficulty:'easy'}] as any[];
const runtimeSha256='a'.repeat(64),rubricVersion='lifecycle-regression-v1',contractVersion='2';
const pack=JSON.parse(await readFile(new URL('../data/english-vocabulary/commerce-v1.json',import.meta.url),'utf8'));

test('immutable drafts, exact evaluation, guarded promotion and rollback on PostgreSQL',{skip:!url,timeout:60000},async t=>{
 const name='release_lifecycle_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:url});await admin.connect();let client:pg.Client|undefined;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);const target=new URL(url!);target.pathname='/'+name;client=new pg.Client({connectionString:target.href});await client.connect();
  const migrations=new URL('../migrations/',import.meta.url);for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await client.query(await readFile(new URL(file,migrations),'utf8'));
  const c=client;
  const initial=await stageRelease(c,{dictionary,corpus,baseReleaseId:null,source:'test-bootstrap'});
  assert.equal(await currentReleaseId(c),null);
  await bootstrapRelease(c,{releaseId:initial.releaseId,actor:'test',reason:'disposable initial fixture'});
  const snapshot=async()=>JSON.stringify({channels:(await c.query('SELECT * FROM release.channels')).rows,releases:(await c.query('SELECT id FROM release.dictionaries ORDER BY id')).rows,candidates:(await c.query('SELECT * FROM release.candidates ORDER BY release_id')).rows});
  const staged=await stageRelease(c,{dictionary:{...dictionary,version:dictionary.version+1},corpus,baseReleaseId:initial.releaseId,source:'test-change'});
  const evaluate=async(releaseId:string,passed=true)=>{const frozen=await loadRelease(c,releaseId);return recordReleaseEvaluation(c,{releaseId,artifactSha256:frozen.artifactSha256,corpusSha256:frozen.corpusSha256,runtimeSha256,rubricVersion,contractVersion,passed,report:{cases:1,passed}});};
  const options={releaseId:staged.releaseId,expectedActiveReleaseId:initial.releaseId,runtimeSha256,rubricVersion,contractVersion,actor:'test',reason:'regression promotion'};
  await t.test('draft isolation, revisions and exact frozen membership',async()=>{
   const draft=await createReleaseDraft(c,{dictionary,corpus,baseReleaseId:initial.releaseId,source:'isolated-draft',change:{kind:'grammar',key:'test',payload:{reviewed:true}}});
   const revision=await reviseReleaseDraft(c,{draftId:draft.draftId,expectedRevision:1,dictionary:{...dictionary,version:dictionary.version+2},corpus:[],change:{kind:'grammar',key:'test2',payload:{reviewed:true}}});
   await assert.rejects(reviseReleaseDraft(c,{draftId:draft.draftId,expectedRevision:1,dictionary,corpus,change:{kind:'grammar',key:'stale',payload:{}}}),/revision changed/);
   const frozen=await freezeReleaseDraft(c,{draftId:draft.draftId,revision:revision.revision});
   assert.equal((await loadRelease(c,frozen.releaseId)).dictionary.corpus.length,0);
   assert.equal((await loadRelease(c,frozen.releaseId)).dictionary.version,dictionary.version+2);
   assert.equal((await freezeReleaseDraft(c,{draftId:draft.draftId,revision:revision.revision})).releaseId,frozen.releaseId);
   await assert.rejects(c.query('INSERT INTO release.draft_changes(draft_id,revision,change_key,kind,payload) VALUES($1,2,\'late\',\'grammar\',\'{}\')',[draft.draftId]),/immutable/);
   assert.equal(await currentReleaseId(c),initial.releaseId);
  });
  await t.test('vocabulary staging changes only its candidate and explicit membership',async()=>{
   const before=(await c.query('SELECT count(*) AS n FROM semantic.terms')).rows[0].n;
   const result=await importVocabulary(c,pack,{apply:true,expectedFingerprint:dictionary.generationFingerprint});
   assert.equal(result.applied,true);assert.equal((await c.query('SELECT count(*) AS n FROM semantic.terms')).rows[0].n,before);
   const loaded=await loadRelease(c,result.releaseId);assert.equal(loaded.base_release_id,initial.releaseId);
   assert.equal((await c.query('SELECT kind FROM release.draft_changes WHERE draft_id=$1',[loaded.draft_id])).rows[0].kind,'vocabulary-pack');
   const sibling=await stageRelease(c,{dictionary,corpus,baseReleaseId:initial.releaseId,source:'sibling'});
   const siblingDictionary=(await loadRelease(c,sibling.releaseId)).dictionary;
   for(const term of pack.terms)assert.equal(siblingDictionary.groups.find((g:any)=>g.code===term.group).terms.includes(term.surface),false);
  });
  await t.test('evaluation rejects wrong identities and promotion requires exact passing evidence',async()=>{
   await assert.rejects(recordReleaseEvaluation(c,{releaseId:staged.releaseId,artifactSha256:'0'.repeat(64),corpusSha256:staged.corpusSha256,runtimeSha256,rubricVersion,contractVersion,passed:true,report:{}}),/identity mismatch/);
   const failed=await evaluate(staged.releaseId,false);await assert.rejects(promoteRelease(c,{...options,evaluationId:failed}),/passing evaluation/);
   const wrongCandidate=await evaluate(initial.releaseId);await assert.rejects(promoteRelease(c,{...options,evaluationId:wrongCandidate}),/exact candidate/);
   const good=await evaluate(staged.releaseId);
   await assert.rejects(promoteRelease(c,{...options,evaluationId:good,runtimeSha256:'b'.repeat(64)}),/runtime/);
   await assert.rejects(promoteRelease(c,{...options,evaluationId:good,rubricVersion:'other'}),/rubric/);
   await assert.rejects(promoteRelease(c,{...options,evaluationId:good,contractVersion:'other'}),/contract/);
   await assert.rejects(c.query('UPDATE release.evaluations SET passed=true WHERE id=$1',[failed]),/immutable/);
   await assert.rejects(c.query("UPDATE release.channels SET release_id=$1 WHERE channel='production'",[staged.releaseId]),/gated activation/);
   await assert.rejects(c.query("INSERT INTO release.activations(channel,release_id) VALUES('production',$1)",[staged.releaseId]),/lifecycle operation/);
   await promoteRelease(c,{...options,evaluationId:good});assert.equal(await currentReleaseId(c),staged.releaseId);
  });
  await t.test('bootstrap and stale promotion fail; rollback requires vetted provenance',async()=>{
   await assert.rejects(bootstrapRelease(c,{releaseId:initial.releaseId,actor:'test',reason:'not empty'}),/empty/);
   const stale=await stageRelease(c,{dictionary,corpus,baseReleaseId:initial.releaseId,source:'stale'}),evidence=await evaluate(stale.releaseId);
   await assert.rejects(promoteRelease(c,{...options,releaseId:stale.releaseId,evaluationId:evidence}),/Active release changed/);
   await assert.rejects(promoteRelease(c,{...options,releaseId:stale.releaseId,expectedActiveReleaseId:staged.releaseId,evaluationId:evidence}),/base is stale/);
   await assert.rejects(rollbackRelease(c,{releaseId:stale.releaseId,expectedActiveReleaseId:staged.releaseId,actor:'test',reason:'unvetted'}),/baseline/);
   await rollbackRelease(c,{releaseId:initial.releaseId,expectedActiveReleaseId:staged.releaseId,actor:'test',reason:'rehearsal'});
   assert.equal(await currentReleaseId(c),initial.releaseId);
  });
  await t.test('candidate IDs are idempotent and conflicting content changes nothing',async()=>{
   const before=await snapshot();const again=await stageRelease(c,{releaseId:staged.releaseId,dictionary:(await loadRelease(c,staged.releaseId)).dictionary,corpus,baseReleaseId:initial.releaseId,source:'test-change'});assert.equal(again.releaseId,staged.releaseId);assert.equal(await snapshot(),before);
   await assert.rejects(stageRelease(c,{releaseId:staged.releaseId,dictionary,corpus,baseReleaseId:initial.releaseId,source:'collision'}),/different immutable content|fingerprint does not match/);assert.equal(await snapshot(),before);
  });
  await t.test('concurrent promotions have one winner and a stale loser',async()=>{
   const a=await stageRelease(c,{dictionary,corpus,baseReleaseId:initial.releaseId,source:'concurrent-a'}),b=await stageRelease(c,{dictionary,corpus,baseReleaseId:initial.releaseId,source:'concurrent-b'});
   const ae=await evaluate(a.releaseId),be=await evaluate(b.releaseId),other=new pg.Client({connectionString:target.href});await other.connect();
   try{const results=await Promise.allSettled([promoteRelease(c,{...options,releaseId:a.releaseId,evaluationId:ae}),promoteRelease(other,{...options,releaseId:b.releaseId,evaluationId:be})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(String((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/Active release changed/);}finally{await other.end();}
  });
  await t.test('channel gate rejects stale same-transaction activation and forces transaction identity',async()=>{
   const active=await currentReleaseId(c);
   const a=await stageRelease(c,{dictionary,corpus,baseReleaseId:active,source:'ordered-a'}),b=await stageRelease(c,{dictionary,corpus,baseReleaseId:active,source:'ordered-b'});
   const ae=await evaluate(a.releaseId),be=await evaluate(b.releaseId);
   await c.query('BEGIN');
   try{
    const event=(await c.query("INSERT INTO release.activations(channel,release_id,previous_release_id,evaluation_id,actor,reason,operation,transaction_id) VALUES('production',$1,$2,$3,'test','transaction-order','promotion',0) RETURNING transaction_id=txid_current() AS current_transaction",[a.releaseId,active,ae])).rows[0];
    assert.equal(event.current_transaction,true,'caller-supplied transaction IDs cannot impersonate another transaction');
    await c.query("INSERT INTO release.activations(channel,release_id,previous_release_id,evaluation_id,actor,reason,operation) VALUES('production',$1,$2,$3,'test','transaction-order','promotion')",[b.releaseId,active,be]);
    await c.query("UPDATE release.channels SET release_id=$1 WHERE channel='production'",[a.releaseId]);
    await assert.rejects(c.query("UPDATE release.channels SET release_id=$1 WHERE channel='production'",[b.releaseId]),/current predecessor/);
   }finally{await c.query('ROLLBACK');}
   assert.equal(await currentReleaseId(c),active,'failed stale activation leaves the active pointer unchanged');
  });
  await t.test('frozen draft membership insertion waits for concurrent freeze then rejects',async()=>{
   const draft=await createReleaseDraft(c,{dictionary,corpus,baseReleaseId:await currentReleaseId(c),source:'concurrent-freeze'});
   const writer=new pg.Client({connectionString:target.href});await writer.connect();
   let releaseCommit!:()=>void,signalCommit!:()=>void;
   const atCommit=new Promise<void>(done=>{signalCommit=done;}),allowCommit=new Promise<void>(done=>{releaseCommit=done;});
   const pausedClient={query:async(...args:any[])=>{if(args[0]==='COMMIT'){signalCommit();await allowCommit;}return (c.query as any)(...args);}};
   const freezing=freezeReleaseDraft(pausedClient as any,{draftId:draft.draftId.toUpperCase(),revision:1});
   try{
    await atCommit;
    await writer.query("SET lock_timeout='200ms'");
    const insert=()=>writer.query("INSERT INTO release.draft_changes(draft_id,revision,change_key,kind,payload) VALUES($1,1,'late-concurrent','grammar','{}')",[draft.draftId]);
    await assert.rejects(insert(),/lock timeout/,'an insertion cannot pass the check while freeze is uncommitted');
    releaseCommit();await freezing;
    await assert.rejects(insert(),/frozen draft membership is immutable/);
    assert.equal((await c.query("SELECT count(*) AS n FROM release.draft_changes WHERE draft_id=$1 AND change_key='late-concurrent'",[draft.draftId])).rows[0].n,'0');
   }finally{releaseCommit();await freezing;await writer.end();}
  });
  await t.test('mid-stage failure rolls back dictionary, draft and candidate together',async()=>{
   await c.query("CREATE FUNCTION release.fail_test_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected candidate failure'; END $$");await c.query('CREATE TRIGGER test_candidate_failure BEFORE INSERT ON release.candidates FOR EACH ROW EXECUTE FUNCTION release.fail_test_candidate()');
   try{const before=await snapshot();await assert.rejects(stageRelease(c,{dictionary,corpus,baseReleaseId:await currentReleaseId(c),source:'failure'}),/injected/);assert.equal(await snapshot(),before);}finally{await c.query('DROP TRIGGER test_candidate_failure ON release.candidates');}
  });
 }finally{if(client)await client.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
});

test('migration records the immutable active baseline without invented historical provenance',{skip:!url,timeout:60000},async()=>{
 const admin=new pg.Client({connectionString:url}),name='release_upgrade_'+randomUUID().replaceAll('-','');await admin.connect();let c:pg.Client|undefined;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);const target=new URL(url!);target.pathname='/'+name;c=new pg.Client({connectionString:target.href});await c.connect();
  const root=new URL('../migrations/',import.meta.url);for(const file of (await readdir(root)).filter(f=>f.endsWith('.sql')&&Number(f.slice(0,3))<22).sort())await c.query(await readFile(new URL(file,root),'utf8'));
  const id=randomUUID();await c.query('INSERT INTO release.dictionaries(id,dictionary_version,fingerprint,schema_version,artifact,corpus_gzip) VALUES($1,5,\'legacy\',2,$2,$3)',[id,dictionary,gzipSync(Buffer.from(''))]);await c.query("INSERT INTO release.channels(channel,release_id) VALUES('production',$1)",[id]);await c.query("INSERT INTO release.activations(channel,release_id) VALUES('production',$1)",[id]);
  await c.query(await readFile(new URL('022_release_lifecycle.sql',root),'utf8'));
  assert.deepEqual((await c.query('SELECT release_id,origin FROM release.baselines')).rows,[{release_id:id,origin:'existing-active'}]);
  const history=(await c.query('SELECT actor,reason,evaluation_id,operation FROM release.activations')).rows[0];assert.deepEqual(history,{actor:null,reason:null,evaluation_id:null,operation:null});
  assert.equal((await c.query('SELECT count(*) AS n FROM release.candidates')).rows[0].n,'0');
 }finally{if(c)await c.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
});


test('verified legacy baseline import preserves identity and external lineage without promotion evidence',{skip:!url,timeout:60000},async()=>{
 const admin=new pg.Client({connectionString:url}),name='release_import_'+randomUUID().replaceAll('-','');await admin.connect();let c:pg.Client|undefined;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);const target=new URL(url!);target.pathname='/'+name;c=new pg.Client({connectionString:target.href});await c.connect();
  const root=new URL('../migrations/',import.meta.url);for(const file of (await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await c.query(await readFile(new URL(file,root),'utf8'));
  const releaseId=randomUUID(),baseReleaseId=randomUUID(),legacy={...dictionary,generationFingerprint:'legacy-generator-fingerprint'},archive=gzipSync(Buffer.from(JSON.stringify(corpus[0])+'\n')),hashes=releaseContentHashes(legacy,archive);
  const input={releaseId,dictionary:legacy,corpus,corpusArchive:archive,baseReleaseId,...hashes,runtimeSha256};
  await importBaselineRelease(c,input);const stored=await loadRelease(c,releaseId);
  assert.equal(stored.fingerprint,legacy.generationFingerprint);assert.equal(stored.base_release_id,baseReleaseId);assert.equal(stored.imported_baseline,true);assert.equal(stored.draft_id,null);
  assert.equal(await currentReleaseId(c),null);assert.equal((await c.query('SELECT count(*) AS n FROM release.evaluations')).rows[0].n,'0');
  await assert.rejects(recordReleaseEvaluation(c,{releaseId,...hashes,runtimeSha256,rubricVersion,contractVersion,passed:true,report:{}}),/no candidate provenance/);
  assert.equal((await importBaselineRelease(c,input)).imported,false);
  await assert.rejects(importBaselineRelease(c,{...input,dictionary:{...legacy,version:legacy.version+1}}),/identity differs/);
  const changed={...legacy,version:legacy.version+1};await assert.rejects(importBaselineRelease(c,{...input,dictionary:changed,...releaseContentHashes(changed,archive)}),/different immutable content/);
  await bootstrapRelease(c,{releaseId,actor:'test',reason:'explicit imported baseline bootstrap'});assert.equal(await currentReleaseId(c),releaseId);
  const unvetted=randomUUID();await importBaselineRelease(c,{...input,releaseId:unvetted});
  await assert.rejects(rollbackRelease(c,{releaseId:unvetted,expectedActiveReleaseId:releaseId,actor:'test',reason:'unvetted import'}),/baseline or a previously/);
  assert.equal((await c.query('SELECT count(*) AS n FROM release.candidates')).rows[0].n,'0');
 }finally{if(c)await c.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
});
