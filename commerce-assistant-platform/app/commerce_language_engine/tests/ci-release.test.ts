import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {assertCiTarget} from '../scripts/prepare-ci-release.ts';
const root=new URL('../',import.meta.url),exec=promisify(execFile);

test('CI release preparer requires an explicit disposable loopback target',()=>{
 const environment={CI:'true',CLE_CI_BOOTSTRAP:'true',DATABASE_URL:'postgres://test@127.0.0.1:5432/commerce_language'};
 assert.equal(assertCiTarget(environment).pathname,'/commerce_language');
 assert.throws(()=>assertCiTarget({...environment,CI:'false'}),/CI=true/);
 assert.throws(()=>assertCiTarget({...environment,CLE_CI_BOOTSTRAP:undefined}),/CLE_CI_BOOTSTRAP/);
 assert.throws(()=>assertCiTarget({...environment,DATABASE_URL:'postgres://test@production.example/commerce_language'}),/loopback/);
 assert.throws(()=>assertCiTarget({...environment,DATABASE_URL:'postgres://test@127.0.0.1:5432/commerce'}),/database names/);
});

const adminUrl=process.env.RELEASE_TEST_DATABASE_URL;
test('CI preparation explicitly bootstraps an empty database and exports matching strict-startup artifacts',{skip:!adminUrl,timeout:60000},async()=>{
 const admin=new pg.Client({connectionString:adminUrl});await admin.connect();
 const name='language_ci_'+randomUUID().replaceAll('-',''),output=await mkdtemp(join(tmpdir(),'ci-release-output-'));
 const source=pathToFileURL(join(process.env.CLE_DEPLOY_DATA_DIR!,'compiled.json')),original=await readFile(source);
 let created=false;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  const target=new URL(adminUrl!);target.pathname='/'+name;
  const env={...process.env,CI:'true',CLE_CI_BOOTSTRAP:'true',DATABASE_URL:target.href,CLE_DEPLOY_DATA_DIR:output};
  const args=['scripts/prepare-ci-release.ts','--artifact',fileURLToPath(source),'--output-dir',output];
  const prepared=JSON.parse((await exec(process.execPath,args,{cwd:root,env,timeout:30000})).stdout);
  assert.equal(prepared.corpusCases,4);assert.match(prepared.qualityScope,/not release-quality/);
  assert.deepEqual(await readFile(source),original,'local testing must not overwrite the reviewed source artifact');
  await exec(process.execPath,['scripts/deploy-start.ts','--verify-only'],{cwd:root,env,timeout:30000});
  const bundle=await readFile(join(output,'deployment-release.json.gz'));
  await assert.rejects(exec(process.execPath,args,{cwd:root,env,timeout:30000}),/requires an empty database/);
  assert.deepEqual(await readFile(join(output,'deployment-release.json.gz')),bundle,'refusing an existing install must preserve output');
 }finally{
  if(created){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[name]);await admin.query(`DROP DATABASE "${name}"`);}
  await admin.end();await rm(output,{recursive:true,force:true});
 }
});
