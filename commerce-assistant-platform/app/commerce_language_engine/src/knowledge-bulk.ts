/** Resumable bounded transport for an immutable English pack; never activates it. */
import {createHash} from 'node:crypto';
import {mkdir,open,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {PoolClient} from 'pg';
import {canonicalKnowledge,knowledgeHash,type LanguageKnowledgePack,type KnowledgeConcept} from './language-knowledge.ts';
import {importLanguageKnowledge} from './knowledge-store.ts';

type Client=Pick<PoolClient,'query'>;
type Chunk={file:string;sha256:string;records:number;bytes:number};
export type BulkManifest={schemaVersion:1;packSha256:string;concepts:number;header:Omit<LanguageKnowledgePack,'concepts'>;chunks:Chunk[]};
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const hex=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>k in v);
const MAX_CHUNK=1024*1024,MAX_MANIFEST=1024*1024,MAX_PACK=32*1024*1024,MAX_RECORD=32*1024;

export function parseBulkManifest(input:unknown):BulkManifest{
 if(!object(input)||!exact(input,['schemaVersion','packSha256','concepts','header','chunks'])||input.schemaVersion!==1||!hex(input.packSha256)||!Number.isSafeInteger(input.concepts)||Number(input.concepts)<1||Number(input.concepts)>100000||!object(input.header)||'concepts' in input.header||input.header.language!=='en'||!Array.isArray(input.chunks)||!input.chunks.length||input.chunks.length>10000)throw new Error('Invalid bulk manifest');
 let total=0,bytes=0;
 input.chunks.forEach((c,i)=>{
  if(!object(c)||!exact(c,['file','sha256','records','bytes'])||c.file!==`chunk-${String(i).padStart(5,'0')}.jsonl`||!hex(c.sha256)||!Number.isInteger(c.records)||Number(c.records)<1||Number(c.records)>500||!Number.isInteger(c.bytes)||Number(c.bytes)<1||Number(c.bytes)>MAX_CHUNK)throw new Error('Invalid bulk chunk descriptor');
  total+=Number(c.records);bytes+=Number(c.bytes);
 });
 if(total!==input.concepts||bytes+Buffer.byteLength(JSON.stringify(input.header))>MAX_PACK||Buffer.byteLength(JSON.stringify(input))>MAX_MANIFEST)throw new Error('Bulk manifest count or runtime pack size limit exceeded');
 return structuredClone(input) as BulkManifest;
}

/** File descriptors bound reads even if a file grows or a symlink changes. */
export async function boundedRead(path:string,limit:number):Promise<Buffer>{
 const f=await open(path,'r');
 try{if(!(await f.stat()).isFile())throw new Error('Expected a regular file');const b=Buffer.alloc(limit+1);let n=0;
  while(n<b.length){const r=await f.read(b,n,b.length-n,null);if(!r.bytesRead)break;n+=r.bytesRead;}
  if(n>limit)throw new Error('Input exceeds byte limit');return b.subarray(0,n);
 }finally{await f.close();}
}
export async function readBulkManifest(directory:string){return parseBulkManifest(JSON.parse((await boundedRead(join(directory,'manifest.json'),MAX_MANIFEST)).toString('utf8')));}
export function decodeChunk(bytes:Buffer,expected:Chunk):KnowledgeConcept[]{
 if(bytes.length!==expected.bytes||bytes.length>MAX_CHUNK||sha(bytes)!==expected.sha256)throw new Error('Chunk checksum or size mismatch');
 const text=bytes.toString('utf8');if(!bytes.equals(Buffer.from(text))||!text.endsWith('\n'))throw new Error('Chunk must be UTF-8 JSONL with a final newline');
 const lines=text.slice(0,-1).split('\n');if(lines.length!==expected.records)throw new Error('Chunk record count mismatch');
 const ids=new Set<string>();
 return lines.map(line=>{
  if(Buffer.byteLength(line)>MAX_RECORD)throw new Error('Concept record exceeds byte limit');
  const r=JSON.parse(line);if(!object(r)||typeof r.id!=='string'||!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(r.id)||ids.has(r.id))throw new Error('Invalid or duplicate chunk concept ID');
  ids.add(r.id);return r as KnowledgeConcept;
 });
}
export async function prepareBulkBundle(input:unknown,directory:string,batchSize=250){
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>500)throw new Error('Batch size must be 1..500');
 const pack=canonicalKnowledge(input),{concepts,...header}=pack,chunks:Chunk[]=[];
 if(Buffer.byteLength(JSON.stringify(pack))>MAX_PACK)throw new Error('Runtime pack size limit exceeded');
 // A new directory avoids overwriting an upload being resumed by another operator.
 await mkdir(directory,{recursive:false});
 let rows:string[]=[],length=0;
 async function flush(){if(!rows.length)return;const bytes=Buffer.from(rows.join('')),file=`chunk-${String(chunks.length).padStart(5,'0')}.jsonl`;await writeFile(join(directory,file),bytes,{flag:'wx'});chunks.push({file,sha256:sha(bytes),records:rows.length,bytes:bytes.length});rows=[];length=0;}
 for(const c of concepts){const line=JSON.stringify(c)+'\n',n=Buffer.byteLength(line);if(n>MAX_RECORD)throw new Error('Concept record exceeds byte limit');if(rows.length>=batchSize||length+n>MAX_CHUNK)await flush();rows.push(line);length+=n;}
 await flush();const manifest=parseBulkManifest({schemaVersion:1,packSha256:knowledgeHash(pack),concepts:concepts.length,header,chunks});
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}
async function locked<T>(client:Client,id:string,run:()=>Promise<T>){
 if(!hex(id))throw new Error('Invalid import ID');
 const key=Number.parseInt(id.slice(0,8),16)|0;
 const held=(await client.query('SELECT pg_try_advisory_lock(57440,$1) AS held',[key])).rows[0].held;
 if(!held)throw new Error('Import is busy; retry later');
 try{return await run();}finally{await client.query('SELECT pg_advisory_unlock(57440,$1)',[key]);}
}
async function job(client:Client,id:string){const row=(await client.query('SELECT * FROM knowledge.bulk_imports WHERE id=$1',[id])).rows[0];if(!row)throw new Error('Unknown import');return row;}
export async function inspectBulkImport(client:Client,id:string){
 if(!hex(id))throw new Error('Invalid import ID');const row=await job(client,id),manifest=parseBulkManifest(row.manifest);
 const chunks=(await client.query('SELECT ordinal,sha256,record_count,byte_count FROM knowledge.bulk_chunks WHERE import_id=$1 ORDER BY ordinal',[id])).rows;
 return {id,status:row.status,packSha256:manifest.packSha256,expectedFingerprint:row.expected_fingerprint,concepts:manifest.concepts,completedConcepts:chunks.reduce((n,r)=>n+r.record_count,0),totalChunks:manifest.chunks.length,completedChunks:chunks.length,missingChunks:manifest.chunks.flatMap((_,i)=>chunks.some(r=>r.ordinal===i)?[]:[i]),releaseId:row.release_id,activated:false};
}
export async function uploadBulkBundle(client:Client,directory:string,expectedFingerprint:string,maxChunks=10000){
 if(!hex(expectedFingerprint)||!Number.isSafeInteger(maxChunks)||maxChunks<0||maxChunks>10000)throw new Error('Invalid expected fingerprint or chunk limit');
 const manifest=await readBulkManifest(directory),id=knowledgeHash({manifest,expectedFingerprint});
 return locked(client,id,async()=>{
  await client.query('INSERT INTO knowledge.bulk_imports(id,manifest,expected_fingerprint) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[id,manifest,expectedFingerprint]);
  const row=await job(client,id);if(knowledgeHash(row.manifest)!==knowledgeHash(manifest)||row.expected_fingerprint!==expectedFingerprint)throw new Error('Import identity mismatch');
  if(row.status==='cancelled')throw new Error('Import was cancelled');if(row.status==='imported')return inspectBulkImport(client,id);
  const completed=new Map((await client.query('SELECT ordinal,sha256 FROM knowledge.bulk_chunks WHERE import_id=$1',[id])).rows.map(r=>[r.ordinal,r.sha256]));let written=0;
  for(const [ordinal,chunk] of manifest.chunks.entries()){
   if(completed.has(ordinal)){if(completed.get(ordinal)!==chunk.sha256)throw new Error('Stored checkpoint checksum mismatch');continue;}
   if(written>=maxChunks)break;
   const records=decodeChunk(await boundedRead(join(directory,chunk.file),MAX_CHUNK),chunk);
   await client.query('BEGIN');
   try{
    await client.query('INSERT INTO knowledge.bulk_chunks(import_id,ordinal,sha256,record_count,byte_count) VALUES($1,$2,$3,$4,$5)',[id,ordinal,chunk.sha256,chunk.records,chunk.bytes]);
    await client.query("INSERT INTO knowledge.bulk_concepts(import_id,chunk_ordinal,position,code,record) SELECT $1,$2,(x.ordinality-1)::integer,x.value->>'id',x.value FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS x(value,ordinality)",[id,ordinal,JSON.stringify(records)]);
    await client.query('UPDATE knowledge.bulk_imports SET updated_at=now() WHERE id=$1',[id]);await client.query('COMMIT');written++;
   }catch(e){await client.query('ROLLBACK');throw e;}
  }
  return inspectBulkImport(client,id);
 });
}
export async function finalizeBulkImport(client:Client,id:string){
 return locked(client,id,async()=>{
  const row=await job(client,id);if(row.status==='cancelled')throw new Error('Import was cancelled');if(row.status==='imported')return inspectBulkImport(client,id);
  const manifest=parseBulkManifest(row.manifest),status=await inspectBulkImport(client,id);if(status.missingChunks.length)throw new Error('Import is incomplete');
  const concepts:KnowledgeConcept[]=[];
  for(const [ordinal,chunk] of manifest.chunks.entries()){
   const records=(await client.query('SELECT record FROM knowledge.bulk_concepts WHERE import_id=$1 AND chunk_ordinal=$2 ORDER BY position',[id,ordinal])).rows.map(r=>r.record);
   // PostgreSQL JSONB can reorder object keys; the canonical whole-pack hash below
   // verifies content. The original transport-byte hashes remain in checkpoints.
   if(records.length!==chunk.records)throw new Error('Stored chunk count mismatch');concepts.push(...records);
  }
  const pack=canonicalKnowledge({...manifest.header,concepts});if(knowledgeHash(pack)!==manifest.packSha256)throw new Error('Stored pack checksum mismatch');
  const result=await importLanguageKnowledge(client,pack,{apply:true,expectedFingerprint:row.expected_fingerprint});
  if(!result.releaseId)throw new Error('Candidate release was not stored');
  // If the process stops after candidate commit, repeating finalization recovers
  // the existing immutable candidate via importLanguageKnowledge's identity key.
  await client.query("UPDATE knowledge.bulk_imports SET status='imported',release_id=$2,updated_at=now() WHERE id=$1",[id,result.releaseId]);
  return inspectBulkImport(client,id);
 });
}
export async function cancelBulkImport(client:Client,id:string){
 return locked(client,id,async()=>{const row=await job(client,id);if(row.status==='imported')throw new Error('Imported candidates cannot be cancelled as uploads');if(row.status!=='cancelled')await client.query("UPDATE knowledge.bulk_imports SET status='cancelled',updated_at=now() WHERE id=$1",[id]);return inspectBulkImport(client,id);});
}
