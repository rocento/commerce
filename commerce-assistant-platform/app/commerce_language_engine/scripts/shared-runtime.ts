import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {withDb} from '../src/database.ts';
import {loadRelease} from '../src/release-lifecycle.ts';
import {runtimeSha256} from '../src/runtime-identity.ts';
import {compile} from '../src/compiler.ts';
import {RELEASE_RUBRIC_VERSION} from './release-evaluation.ts';
import {RELEASE_CONTRACT_VERSION} from './deployment-release.ts';
import type {Dictionary} from '../src/types.ts';

// Every production consumer verifies. Publishing always uses operator commands.
export async function verifyDatabaseRuntime(compiled:Dictionary,options:{shared?:boolean;releaseId?:string;allowLegacyBaselineTransition?:boolean}={}){
 const runtimeHash=await runtimeSha256();
 return withDb(async c=>{
  const applied=await c.query('SELECT filename,sha256 FROM public.schema_migrations');
  const checksums=new Map(applied.rows.map(r=>[r.filename,r.sha256]));
  for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql'))){
   const body=await readFile(new URL('../migrations/'+file,import.meta.url));
   assert.equal(checksums.get(file),createHash('sha256').update(body).digest('hex'),`Runtime migration is missing or differs: ${file}`);
  }
  const active=(await c.query("SELECT d.id,d.fingerprint,d.artifact FROM release.channels ch JOIN release.dictionaries d ON d.id=ch.release_id WHERE ch.channel='production'")).rows[0];
  assert.equal(active?.fingerprint,compiled.generationFingerprint,'Active language release differs from runtime image; use explicit release promotion before deployment');
  const {corpus:_compiled,...expected}=compiled;
  const {corpus:_active,...actual}=active.artifact;
  assert.ok(isDeepStrictEqual({...actual,schemaVersion:compile({...active.artifact,corpus:[]}).schemaVersion},expected),'Active language artifact differs from runtime image');
  if(options.releaseId)assert.equal(active.id,options.releaseId,'Active release UUID differs from runtime image');
  const release=await loadRelease(c,active.id);
  if(release.draft_id){
   const activation=(await c.query("SELECT operation,evaluation_id FROM release.activations WHERE release_id=$1 ORDER BY id DESC LIMIT 1",[active.id])).rows[0];
   // Rollback uses the target's original approved evaluation. An explicitly
   // bootstrapped generated candidate still needs measured evidence to serve.
   const evidence=await c.query(`SELECT 1 FROM release.evaluations e WHERE e.release_id=$1 AND e.passed
    AND e.artifact_sha256=$2 AND e.corpus_sha256=$3 AND e.runtime_sha256=$4
    AND e.rubric_version=$5 AND e.contract_version=$6
    AND ($7::uuid IS NULL OR e.id=$7) LIMIT 1`,[active.id,release.artifactSha256,release.corpusSha256,runtimeHash,RELEASE_RUBRIC_VERSION,String(RELEASE_CONTRACT_VERSION),activation?.operation==='promotion'?activation.evaluation_id:null]);
   assert.ok(evidence.rowCount,'Active candidate has no passing evaluation for this exact runtime, artifact, corpus, contract and rubric; re-exporting cannot approve a parser change.');
  }else{
   const imported=(await c.query('SELECT runtime_sha256 FROM release.imported_baselines WHERE release_id=$1',[active.id])).rows[0];
   if(imported)assert.equal(imported.runtime_sha256,runtimeHash,'Imported baseline runtime differs from its verified source; create and evaluate a new draft for parser changes.');
   else {
    const baseline=await c.query('SELECT 1 FROM release.baselines WHERE release_id=$1',[active.id]);
    assert.ok(baseline.rowCount&&options.allowLegacyBaselineTransition,'Historical baseline has unknown runtime provenance. Use the explicit temporary legacy-baseline transition flag only during the reviewed migration, then create and evaluate a new draft.');
   }
  }
  if(options.shared){
   const tenant=(await c.query('SELECT context.login_tenant() AS tenant')).rows[0]?.tenant;
   assert.ok(tenant,'Shared language runtime has no tenant mapping');
  }
  return {releaseId:active.id as string};
 });
}
export async function verifySharedRuntime(compiled:Dictionary){return verifyDatabaseRuntime(compiled,{shared:true});}
