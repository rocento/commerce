import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,rename,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {gunzipSync} from 'node:zlib';
import {releaseContentHashes} from '../src/release-lifecycle.ts';
import {runtimeSha256} from '../src/runtime-identity.ts';
import {createReleaseBundle,RELEASE_CONTRACT_VERSION,type ReleasePayload,uuidPattern} from './deployment-release.ts';
import {compile} from '../src/compiler.ts';
import {rocentoDictionary} from '../src/rocento-capabilities.ts';
import type {CorpusCase,Dictionary} from '../src/types.ts';

export type DatabaseReleaseRow={id:string;base_release_id?:string|null;artifact_sha256?:string;corpus_sha256?:string;dictionary_version:number;fingerprint:string;artifact:Dictionary;corpus_gzip:Buffer;manifest:Record<string,any>};
/** Build and validate every related artifact before touching the destination. */
export function prepareDatabaseExport(row:DatabaseReleaseRow,runtimeHash:string){
 assert.ok(row&&uuidPattern.test(row.id),'Export requires the exact immutable release UUID.');
 assert.match(runtimeHash,/^[a-f0-9]{64}$/,'Export requires a runtime SHA-256 hash.');
 assert.ok(row?.corpus_gzip,'The selected database release has no archived corpus.');
 assert.ok(typeof row.fingerprint==='string'&&row.fingerprint.length>0,'The selected release has no fingerprint.');
 assert.equal(row.artifact.version,row.dictionary_version,'Stored dictionary version differs from release metadata.');
 assert.equal(row.artifact.generationFingerprint,row.fingerprint,'Stored dictionary fingerprint differs from release metadata.');
 const corpusText=gunzipSync(row.corpus_gzip).toString('utf8');
 const corpus=corpusText.split('\n').filter(Boolean).map(line=>JSON.parse(line) as CorpusCase);
 assert.ok(corpus.length>0,'The selected database release has an empty corpus.');
 assert.ok(corpus.every(c=>c&&typeof c.text==='string'&&typeof c.difficulty==='string'),'Archived corpus has invalid cases.');
 const source={...row.artifact,corpus:[]} as Dictionary;
 const dictionary=rocentoDictionary(source);
 // A release fingerprint must keep identifying the same dictionary during export.
 assert.deepEqual(dictionary,source,'Selected dictionary needs a new reviewed release before export; runtime preparation changes its content.');
 const schemaVersion=compile(dictionary).schemaVersion;
 const artifact={...dictionary,corpus:[],schemaVersion};
 const manifest={...row.manifest,version:row.dictionary_version,fingerprint:row.fingerprint,counts:{...row.manifest?.counts,evaluationUtterances:corpus.length}};
 const hashes=releaseContentHashes(row.artifact,row.corpus_gzip);
 if(row.artifact_sha256)assert.equal(row.artifact_sha256,hashes.artifactSha256,'Stored artifact hash mismatch.');
 if(row.corpus_sha256)assert.equal(row.corpus_sha256,hashes.corpusSha256,'Stored corpus hash mismatch.');
 const identity={releaseId:row.id,baseReleaseId:row.base_release_id??null,...hashes,runtimeSha256:runtimeHash,contractVersion:RELEASE_CONTRACT_VERSION,normalizationVersion:'english-v1' as const,clauseSpanEncoding:'utf-16-code-units' as const,evidenceSpanEncoding:'unicode-code-points' as const};
 const payload:ReleasePayload={format:2,identity,artifact:row.artifact,corpus,corpusArchive:row.corpus_gzip.toString('base64'),manifest};
 const bundle=createReleaseBundle(payload);
 return {artifact,manifest,corpus,corpusText,bundle};
}

/** --sync-authoring intentionally updates authoring inputs to the active DB release. */
export async function exportDatabaseRelease(row:DatabaseReleaseRow,data:URL,options:{syncAuthoring?:boolean}={}){
 const prepared=prepareDatabaseExport(row,await runtimeSha256()),json=JSON.stringify(prepared.artifact);
 const files:{name:string;body:string|Buffer;mode?:number}[]=[];
 if(options.syncAuthoring)files.push(
  {name:'generated.json',body:json},
  {name:'generation-report.json',body:JSON.stringify(prepared.manifest,null,2)+'\n'},
  {name:'corpus.jsonl',body:prepared.corpusText,mode:0o600},
 );
 files.push({name:'compiled.json',body:json},{name:'deployment-release.json.gz',body:prepared.bundle,mode:0o600});
 const temporary=files.map(file=>({...file,path:new URL(file.name+'.'+randomUUID()+'.tmp',data),destination:new URL(file.name,data)}));
 await mkdir(data,{recursive:true});
 try{
  // Stage the complete set first. Each rename is atomic; the verified bundle is published last.
  for(const file of temporary)await writeFile(file.path,file.body,file.mode?{mode:file.mode}:undefined);
  for(const file of temporary)await rename(file.path,file.destination);
 }finally{await Promise.all(temporary.map(file=>rm(file.path,{force:true})));}
 return {source:'immutable-database-release',releaseId:row.id,fingerprint:row.fingerprint,corpusCases:prepared.corpus.length,authoringSynced:options.syncAuthoring===true,files:files.map(file=>file.name)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{'sync-authoring':{type:'boolean',default:false},'release-id':{type:'string'}}});
 if(!values['release-id']||!uuidPattern.test(values['release-id']))throw new Error('--release-id <uuid> is required; candidates can be exported before activation.');
 const {closeDb,withDb}=await import('../src/database.ts');
 const {loadRelease}=await import('../src/release-lifecycle.ts');
 let row:DatabaseReleaseRow;
 try{row=await withDb(c=>loadRelease(c,values['release-id']!));}finally{await closeDb();}
 const data=process.env.CLE_EXPORT_OUTPUT_DIR?pathToFileURL(resolve(process.env.CLE_EXPORT_OUTPUT_DIR)+'/'):new URL('../data/',import.meta.url);
 console.log(JSON.stringify(await exportDatabaseRelease(row,data,{syncAuthoring:values['sync-authoring']})));
}
