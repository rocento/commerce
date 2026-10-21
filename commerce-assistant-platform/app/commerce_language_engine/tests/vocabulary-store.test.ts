import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
/** Additive vocabulary drafts never alter shared authoring tables or the active release. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {importVocabulary} from '../src/vocabulary-store.ts';
import {projectVocabulary,vocabularyHash} from '../src/vocabulary-enrichment.ts';
import {stageRelease,bootstrapRelease,loadRelease,currentReleaseId} from '../src/release-lifecycle.ts';
const url=process.env.ENGLISH_VOCABULARY_TEST_DATABASE_URL;
const pack=JSON.parse(await readFile(new URL('../data/english-vocabulary/commerce-v1.json',import.meta.url),'utf8'));
const base=(recognitionFixture(JSON.parse(await readFile(new URL('../data/compiled.json',import.meta.url),'utf8'))));
test('PostgreSQL vocabulary drafts preserve IDs, isolate membership and roll back failures',{skip:!url,timeout:60000},async t=>{
 const admin=new pg.Client({connectionString:url}),name='english_vocab_'+randomUUID().replaceAll('-','');await admin.connect();let c:pg.Client|undefined;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);const target=new URL(url!);target.pathname='/'+name;c=new pg.Client({connectionString:target.href});await c.connect();
  const migrations=new URL('../migrations/',import.meta.url);for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await c.query(await readFile(new URL(file,migrations),'utf8'));
  const initial=await stageRelease(c,{dictionary:base,corpus:[],baseReleaseId:null,source:'test-bootstrap'});await bootstrapRelease(c,{releaseId:initial.releaseId,actor:'test',reason:'disposable fixture'});
  await c.query("INSERT INTO semantic.groups(code,category) VALUES('existing_group','test')");await c.query("INSERT INTO lexicon.terms(term,normalized_term) VALUES('existing surface','existing surface')");await c.query('INSERT INTO semantic.terms(semantic_group_id,lexicon_term_id) SELECT g.id,l.id FROM semantic.groups g CROSS JOIN lexicon.terms l');
  const identities=async()=>({terms:(await c!.query('SELECT * FROM semantic.terms ORDER BY id')).rows,lexicon:(await c!.query('SELECT * FROM lexicon.terms ORDER BY id')).rows});
  const snapshot=async()=>({identities:await identities(),releases:(await c!.query('SELECT id FROM release.dictionaries ORDER BY id')).rows,drafts:(await c!.query('SELECT id FROM release.drafts ORDER BY id')).rows,channel:await currentReleaseId(c!)});
  const before=await snapshot(),options={apply:true,expectedFingerprint:base.generationFingerprint};let staged:any;
  await t.test('dry run and malformed/stale packs have no database effects',async()=>{
   const dry=await importVocabulary(c!,pack,{...options,apply:false});assert.equal(dry.added,23);assert.deepEqual(await snapshot(),before);
   await assert.rejects(importVocabulary(c!,pack,{...options,expectedFingerprint:'stale'}),/fingerprint/);await assert.rejects(importVocabulary(c!,{...pack,reviewState:'pending'},options),/Unapproved/);assert.deepEqual(await snapshot(),before);
  });
  await t.test('candidate membership preserves all authoring rows and IDs',async()=>{
   staged=await importVocabulary(c!,pack,options);assert.equal(staged.applied,true);assert.equal(staged.activated,false);assert.deepEqual(await identities(),before.identities);assert.equal(await currentReleaseId(c!),initial.releaseId);
   const {generationFingerprint:_fingerprint,corpus:_corpus,...content}=projectVocabulary(base,pack).dictionary;assert.equal(staged.candidateFingerprint,vocabularyHash(content));
   const loaded=await loadRelease(c!,staged.releaseId);assert.equal(loaded.base_release_id,initial.releaseId);assert.equal((await c!.query('SELECT kind FROM release.draft_changes WHERE draft_id=$1',[loaded.draft_id])).rows[0].kind,'vocabulary-pack');
   for(const term of pack.terms)assert.equal(loaded.dictionary.groups.find((g:any)=>g.code===term.group).termMetadata[term.surface].enrichment.reviewState,'approved');
  });
  await t.test('reordered repeat imports reuse the same immutable candidate',async()=>{const once=await snapshot();const again=await importVocabulary(c!,{...pack,terms:[...pack.terms].reverse()},options);assert.equal(again.releaseId,staged.releaseId);assert.equal(again.applied,false);assert.deepEqual(await snapshot(),once);});
  await t.test('mid-import failure rolls back candidate and membership',async()=>{
   await c!.query("CREATE FUNCTION release.fail_vocabulary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected import failure'; END $$");await c!.query('CREATE TRIGGER test_fail_import BEFORE INSERT ON release.candidates FOR EACH ROW EXECUTE FUNCTION release.fail_vocabulary()');
   try{const faulty={...pack,id:'failure-rehearsal',terms:[{...pack.terms[0],surface:'zz reviewed wording'}]},state=await snapshot();await assert.rejects(importVocabulary(c!,faulty,options),/injected import failure/);assert.deepEqual(await snapshot(),state);}finally{await c!.query('DROP TRIGGER test_fail_import ON release.candidates');}
  });
  await t.test('held records stay held and published artifacts stay immutable',async()=>{
   await c!.query("INSERT INTO lexicon.terms(term,normalized_term,active) VALUES('held wording','held wording',false)");const held={...pack,id:'held-pack',terms:[{...pack.terms[0],surface:'held wording'}]},state=await snapshot();await assert.rejects(importVocabulary(c!,held,options),/Inactive/);assert.deepEqual(await snapshot(),state);await assert.rejects(c!.query('UPDATE release.dictionaries SET fingerprint=$1 WHERE id=$2',['modified',staged.releaseId]),/immutable/);
  });
 }finally{if(c)await c.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
});
