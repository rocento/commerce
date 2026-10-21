import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {readDeploymentRelease} from '../scripts/deployment-release.ts';

test('deployment inputs reject corrupt or mismatched releases before database startup',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'language-release-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const data=pathToFileURL(directory+'/');
 const compiled=(recognitionFixture(JSON.parse(await readFile(new URL('../data/compiled.json',import.meta.url),'utf8'))));
 await writeFile(new URL('compiled.json',data),JSON.stringify(compiled));
 const payload=()=>({format:1,artifact:structuredClone(compiled),corpus:[],manifest:{fingerprint:compiled.generationFingerprint,counts:{evaluationUtterances:0}}});
 async function bundle(value:ReturnType<typeof payload>,checksum?:string){
  await writeFile(new URL('deployment-release.json.gz',data),gzipSync(JSON.stringify({payload:value,checksum:checksum??createHash('sha256').update(JSON.stringify(value)).digest('hex')})),{mode:0o600});
 }
 await t.test('compiled-only deployments remain supported',async()=>{
  assert.equal((await readDeploymentRelease(data)).release,undefined);
 });
 await t.test('matching private bundle is accepted',async()=>{
  await bundle(payload());
  assert.deepEqual((await readDeploymentRelease(data)).release?.payload,payload());
 });
 await t.test('missing fingerprints cannot masquerade as matching undefined values',async()=>{
  const value=payload();delete value.artifact.generationFingerprint;delete value.manifest.fingerprint;await bundle(value);
  await assert.rejects(readDeploymentRelease(data),/requires a generation fingerprint/);
 });
 await t.test('invalid checksum is rejected',async()=>{
  await bundle(payload(),'invalid');
  await assert.rejects(readDeploymentRelease(data),/checksum mismatch/);
 });
 await t.test('different artifact is rejected even with a valid checksum',async()=>{
  const value=payload();value.artifact.version='stale-release';await bundle(value);
  await assert.rejects(readDeploymentRelease(data),/does not match the deployed compiled dictionary/);
 });
 await t.test('incomplete corpus is rejected',async()=>{
  const value=payload();value.manifest.counts.evaluationUtterances=1;await bundle(value);
  await assert.rejects(readDeploymentRelease(data),{code:'ERR_ASSERTION'});
 });
});
