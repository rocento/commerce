import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {gunzipSync,gzipSync} from 'node:zlib';
import {compile} from '../src/compiler.ts';
import {releaseContentHashes} from '../src/release-lifecycle.ts';
import {runtimeSha256} from '../src/runtime-identity.ts';
import type {CorpusCase,Dictionary} from '../src/types.ts';

export const RELEASE_CONTRACT_VERSION=2;
export type ReleaseIdentity={releaseId:string;baseReleaseId:string|null;artifactSha256:string;corpusSha256:string;runtimeSha256:string;contractVersion:number;normalizationVersion:'english-v1';clauseSpanEncoding:'utf-16-code-units';evidenceSpanEncoding:'unicode-code-points'};
export type LegacyReleasePayload={format:1;artifact:Dictionary;corpus:CorpusCase[];manifest:Record<string,any>};
export type ReleasePayload={format:2;identity:ReleaseIdentity;artifact:Dictionary;corpus:CorpusCase[];corpusArchive:string;manifest:Record<string,any>};
export type DeploymentPayload=LegacyReleasePayload|ReleasePayload;
export const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createReleaseBundle(payload:DeploymentPayload){return gzipSync(Buffer.from(JSON.stringify({payload,checksum:createHash('sha256').update(JSON.stringify(payload)).digest('hex')})));}
export function decodeReleaseBundle(bundle:Buffer){
 const wrapper=JSON.parse(gunzipSync(bundle).toString('utf8'));
 const payload=wrapper.payload as DeploymentPayload;
 assert.equal(wrapper.checksum,createHash('sha256').update(JSON.stringify(payload)).digest('hex'),'Release bundle checksum mismatch.');
 assert.ok(payload.format===1||payload.format===2,'Unsupported release bundle format.');
 assert.ok(Array.isArray(payload.corpus)&&payload.corpus.every(row=>row&&typeof row.text==='string'&&typeof row.difficulty==='string'),'Bundle has invalid corpus cases.');
 assert.ok(typeof payload.artifact.generationFingerprint==='string'&&payload.artifact.generationFingerprint.length>0,'Bundle artifact requires a generation fingerprint.');
 assert.ok(typeof payload.manifest.fingerprint==='string'&&payload.manifest.fingerprint.length>0,'Bundle manifest requires a fingerprint.');
 assert.equal(payload.artifact.generationFingerprint,payload.manifest.fingerprint,'Bundle fingerprint mismatch.');
 assert.equal(payload.corpus.length,payload.manifest.counts.evaluationUtterances,'Bundle corpus count mismatch.');
 compile({...payload.artifact,corpus:[]});
 if(payload.format===2){
  const id=payload.identity;
  assert.ok(uuidPattern.test(id.releaseId),'Bundle release ID must be a UUID.');
  assert.ok(id.baseReleaseId===null||uuidPattern.test(id.baseReleaseId),'Bundle base release ID must be a UUID or null.');
  assert.equal(id.contractVersion,RELEASE_CONTRACT_VERSION,'Unsupported release contract version.');
  assert.equal(id.normalizationVersion,'english-v1');
  assert.equal(id.clauseSpanEncoding,'utf-16-code-units');
  assert.equal(id.evidenceSpanEncoding,'unicode-code-points');
  assert.match(id.runtimeSha256,/^[a-f0-9]{64}$/,'Bundle runtime identity must be a SHA-256 hash.');
  const archive=Buffer.from(payload.corpusArchive,'base64');
  const archived=gunzipSync(archive).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.deepEqual(archived,payload.corpus,'Bundle corpus differs from its immutable archive.');
  const hashes=releaseContentHashes(payload.artifact,archive);
  assert.equal(id.artifactSha256,hashes.artifactSha256,'Bundle artifact hash mismatch.');
  assert.equal(id.corpusSha256,hashes.corpusSha256,'Bundle corpus hash mismatch.');
 }
 return {payload,checksum:wrapper.checksum as string};
}
/** Validate image inputs without connecting to or changing a database. */
export async function readDeploymentRelease(data=new URL('../data/',import.meta.url),options:{verifyRuntime?:boolean}={}) {
 const compiled=JSON.parse(await readFile(new URL('compiled.json',data),'utf8')) as Dictionary;
 compile(compiled);
 let bundle:Buffer;
 try{bundle=await readFile(new URL('deployment-release.json.gz',data));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {compiled,release:undefined};throw error;}
 const release=decodeReleaseBundle(bundle);
 const {corpus:_compiledCorpus,...compiledContent}=compiled;
 const {corpus:_bundleCorpus,...bundleContent}=release.payload.artifact;
 assert.deepEqual({...bundleContent,schemaVersion:compile({...release.payload.artifact,corpus:[]}).schemaVersion},compiledContent,'Release bundle does not match the deployed compiled dictionary.');
 if(release.payload.format===2&&options.verifyRuntime!==false)assert.equal(release.payload.identity.runtimeSha256,await runtimeSha256(),'Release bundle runtime differs from deployed parser source. Reevaluate and export using this runtime.');
 return {compiled,release};
}
