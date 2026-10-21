import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {installEmpty} from '../scripts/install-empty.ts';
import {decodeReleaseBundle,createReleaseBundle} from '../scripts/deployment-release.ts';
import {releaseContentHashes} from '../src/release-lifecycle.ts';

const adminUrl=process.env.RELEASE_TEST_DATABASE_URL;
const data=new URL('../data/',import.meta.url);
const bundle=decodeReleaseBundle(await readFile(new URL('deployment-release.json.gz',data))).payload;
async function fixture(run:(admin:pg.Client,options:{databaseUrl:string;adminDatabase:string;data:URL},name:string)=>Promise<void>){
 const admin=new pg.Client({connectionString:adminUrl});await admin.connect();
 const name='install_empty_'+randomUUID().replaceAll('-',''),url=new URL(adminUrl!);
 const adminDatabase=decodeURIComponent(url.pathname.slice(1));url.pathname='/'+name;
 try{await run(admin,{databaseUrl:url.href,adminDatabase,data},name);}
 finally{await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();}
}
async function snapshot(url:string){
 const client=new pg.Client({connectionString:url});await client.connect();
 try{return (await client.query(`SELECT jsonb_build_object(
 'channels',(SELECT jsonb_agg(to_jsonb(t)) FROM release.channels t),
 'releases',(SELECT jsonb_agg(to_jsonb(t)-'corpus_gzip') FROM release.dictionaries t),
 'activations',(SELECT jsonb_agg(to_jsonb(t)) FROM release.activations t),
 'history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY filename) FROM public.schema_migrations t)) AS value`)).rows[0].value;}
 finally{await client.end();}
}

test('concurrent new installation imports exact packaged release once and reruns preserve it',{skip:!adminUrl,timeout:120000},async()=>fixture(async(_admin,options)=>{
 const results=await Promise.all([installEmpty(options),installEmpty(options)]);
 assert.deepEqual(results.map(r=>r.status).sort(),['existing-database-unchanged','installed']);
 const before=await snapshot(options.databaseUrl);
 assert.equal(before.channels[0].release_id,bundle.format===2?bundle.identity.releaseId:null);
 assert.deepEqual(before.releases[0].artifact,bundle.artifact);
 assert.equal(before.activations.length,1);
 assert.equal(before.history.length,(await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).length);
 await promisify(execFile)(process.execPath,['scripts/deploy-start.ts','--verify-only'],{cwd:new URL('../',import.meta.url),env:{...process.env,DATABASE_URL:options.databaseUrl,CLE_DEPLOY_DATA_DIR:new URL('../data/',import.meta.url).pathname,CLE_SHARED_DATABASE:'false'},timeout:30000});
 assert.equal((await installEmpty({...options,data:new URL('missing-bundle/',data)})).status,'existing-database-unchanged');
 assert.deepEqual(await snapshot(options.databaseUrl),before);
}));

test('precreated empty database is initialized; existing unactivated data is untouched',{skip:!adminUrl,timeout:120000},async()=>{
 await fixture(async(admin,options,name)=>{
  await admin.query(`CREATE DATABASE "${name}"`);
  assert.equal((await installEmpty(options)).status,'installed');
 });
 await fixture(async(admin,options,name)=>{
  await admin.query(`CREATE DATABASE "${name}"`);
  const client=new pg.Client({connectionString:options.databaseUrl});await client.connect();
  try{
   await client.query("CREATE SCHEMA authoring; CREATE TABLE authoring.drafts(value text); INSERT INTO authoring.drafts VALUES('keep unpublished vocabulary')");
   assert.equal((await installEmpty(options)).status,'existing-database-unchanged');
   assert.deepEqual((await client.query('SELECT * FROM authoring.drafts')).rows,[{value:'keep unpublished vocabulary'}]);
   assert.equal((await client.query("SELECT to_regclass('public.schema_migrations') AS history")).rows[0].history,null);
  }finally{await client.end();}
 });
});

test('invalid bundle creates no database; failed activation rolls the whole installation back',{skip:!adminUrl,timeout:120000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'invalid-install-')),badData=pathToFileURL(directory+'/');
 try{
  await writeFile(new URL('compiled.json',badData),await readFile(new URL('compiled.json',data)));
  await writeFile(new URL('deployment-release.json.gz',badData),'invalid');
  await fixture(async(admin,options,name)=>{
   await assert.rejects(installEmpty({...options,data:badData}));
   assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0);
  });
  // A structurally valid but unreviewed release fails during bootstrap, after
  // migrations/import. The outer transaction must undo every one of those writes.
  assert.equal(bundle.format,2);if(bundle.format!==2)return;
  const unreviewed=structuredClone(bundle);
  unreviewed.artifact.languageKnowledge!.ruleGovernance![0].status='draft';
  delete unreviewed.artifact.languageKnowledge!.ruleGovernance![0].review;
  Object.assign(unreviewed.identity,releaseContentHashes(unreviewed.artifact,Buffer.from(unreviewed.corpusArchive,'base64')));
  await writeFile(new URL('compiled.json',badData),JSON.stringify({...unreviewed.artifact,corpus:[],schemaVersion:JSON.parse(await readFile(new URL('compiled.json',data),'utf8')).schemaVersion}));
  await writeFile(new URL('deployment-release.json.gz',badData),createReleaseBundle(unreviewed));
  await fixture(async(_admin,options)=>{
   await assert.rejects(installEmpty({...options,data:badData}),/review/i);
   const client=new pg.Client({connectionString:options.databaseUrl});await client.connect();
   try{assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'")).rows[0].n,0);}
   finally{await client.end();}
   assert.equal((await installEmpty(options)).status,'installed');
  });
 }finally{await rm(directory,{recursive:true,force:true});}
});
