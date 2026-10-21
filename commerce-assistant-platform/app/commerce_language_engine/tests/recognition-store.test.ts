import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {stageRelease,bootstrapRelease,loadRelease,currentReleaseId,createReleaseDraft,freezeReleaseDraft} from '../src/release-lifecycle.ts';
import {stageRecognitionRules} from '../src/recognition-authoring.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const url=process.env.LANGUAGE_RELEASE_TEST_DATABASE_URL;
test('PostgreSQL round trip preserves data-only rules, immutable projections, and inactive candidates',{skip:!url,timeout:60000},async()=>{
 const admin=new pg.Client({connectionString:url}),name='recognition_'+randomUUID().replaceAll('-','');await admin.connect();let client:pg.Client|undefined;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);const target=new URL(url!);target.pathname='/'+name;client=new pg.Client({connectionString:target.href});await client.connect();
  const directory=new URL('../migrations/',import.meta.url);for(const file of (await readdir(directory)).filter(f=>f.endsWith('.sql')).sort())await client.query(await readFile(new URL(file,directory),'utf8'));
  const dictionary=buildExpandedDictionary(),base=await stageRelease(client,{dictionary,corpus:[],baseReleaseId:null,source:'recognition-test'});
  await bootstrapRelease(client,{releaseId:base.releaseId,actor:'test',reason:'disposable database'});
  const rules=structuredClone(dictionary.recognitionRules!);rules.revision++;rules.entries['cart-clear-language.clear.value.1']={kind:'value',value:'(?:purge|clear)'};
  const next=await stageRecognitionRules(client,{baseReleaseId:base.releaseId,expectedActiveReleaseId:base.releaseId,rules});
  assert.equal(await currentReleaseId(client),base.releaseId);
  const restored=await loadRelease(client,next.releaseId);assert.deepEqual(restored.dictionary.recognitionRules,rules);
  assert.equal(resolve(compile(restored.dictionary),'purge my cart').intent,'CLEAR_CART');
  assert.notEqual(resolve(compile((await loadRelease(client,base.releaseId)).dictionary),'purge my cart').intent,'CLEAR_CART');
  const projection=(await client.query('SELECT code,definition FROM release.recognition_rules WHERE release_id=$1',[next.releaseId])).rows;
  assert.deepEqual(Object.fromEntries(projection.map(row=>[row.code,row.definition])),rules.entries);
  await assert.rejects(client.query("UPDATE release.recognition_rules SET definition='{}' WHERE release_id=$1",[next.releaseId]),/immutable/);
  await assert.rejects(client.query('DELETE FROM release.recognition_rules WHERE release_id=$1',[next.releaseId]),/immutable/);
  await assert.rejects(client.query("INSERT INTO release.recognition_rules VALUES($1,'made-up','value',$2)",[next.releaseId,JSON.stringify({kind:'value',value:'bad'})]),/differs/);
  const draft=await createReleaseDraft(client,{dictionary:restored.dictionary,corpus:[],baseReleaseId:base.releaseId,source:'recognition-test-draft'}),frozen=await freezeReleaseDraft(client,{draftId:draft.draftId,revision:1});
  assert.equal(Number((await client.query('SELECT count(*) AS count FROM release.recognition_rules WHERE release_id=$1',[frozen.releaseId])).rows[0].count),Object.keys(rules.entries).length);
  await assert.rejects(stageRecognitionRules(client,{baseReleaseId:base.releaseId,expectedActiveReleaseId:null,rules}),/Active release changed/);
 }finally{await client?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();}
});
