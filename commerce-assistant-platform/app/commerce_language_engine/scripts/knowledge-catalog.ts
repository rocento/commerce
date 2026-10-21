/** Read-only operator catalog over immutable release data; no runtime or activation path. */
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {PoolClient} from 'pg';
import type {Dictionary} from '../src/types.ts';
import {boundedRead} from '../src/knowledge-bulk.ts';
import {canonicalKnowledge,knowledgeHash,type LanguageKnowledgePack} from '../src/language-knowledge.ts';
import {withDictionaryRecognition} from '../src/recognition-rules.ts';
import {ruleDefinitions} from '../src/rule-governance.ts';
import {withDb,closeDb} from '../src/database.ts';

const kinds=['color','country','person','activity','occasion','device','material','product','unit','dimension'];
const key=(value:string)=>value.normalize('NFKC').toLowerCase();
function integer(value:string|undefined,fallback:number,min:number,max:number){
 if(value!==undefined&&!/^\d+$/.test(value))throw new Error('Invalid pagination integer');
 const n=value===undefined?fallback:Number(value);
 if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('Pagination outside bounds');return n;
}
export function searchKnowledge(pack:LanguageKnowledgePack,query='',kind?:string,limit=25,offset=0){
 if(query.length>200||/[\x00-\x1f]/.test(query)||kind!==undefined&&!kinds.includes(kind))throw new Error('Invalid query or kind');
 integer(String(limit),25,1,100);integer(String(offset),0,0,100000);
 const needle=key(query),matches=pack.concepts.filter(c=>(!kind||c.kind===kind)&&[c.id,c.canonical,...c.aliases].some(s=>key(s).includes(needle))).sort((a,b)=>a.id.localeCompare(b.id));
 return {packId:pack.id,revision:pack.revision,packSha256:knowledgeHash(pack),total:matches.length,limit,offset,rows:matches.slice(offset,offset+limit).map(c=>({...c,applicableRules:pack.rules.filter(r=>r.targetKind===c.kind&&Object.entries(r.targetMetadata??{}).every(([k,v])=>c.metadata?.[k]===v)).map(r=>{const review=pack.ruleGovernance?.find(g=>g.family==='relationship'&&g.ruleId===r.id);return {id:r.id,marker:r.marker,relation:r.relation,scope:r.scope,priority:r.priority,source:review?.source,reviewStatus:review?.status,reviewMethod:review?.review?.method};})}))};
}
export function diffKnowledge(before:LanguageKnowledgePack,after:LanguageKnowledgePack){
 if(before.id!==after.id||before.language!==after.language)throw new Error('Cannot compare different knowledge families');
 function changes<T>(old:T[],next:T[],id:(row:T)=>string){
  const a=new Map(old.map(r=>[id(r),r])),b=new Map(next.map(r=>[id(r),r]));
  return {added:[...b.keys()].filter(k=>!a.has(k)).sort(),removed:[...a.keys()].filter(k=>!b.has(k)).sort(),changed:[...b.keys()].filter(k=>a.has(k)&&knowledgeHash(a.get(k))!==knowledgeHash(b.get(k))).sort()};
 }
 const rules=(p:LanguageKnowledgePack)=>ruleDefinitions(p).map(r=>({id:r.family+':'+r.rule.id,definition:r.rule,governance:p.ruleGovernance?.find(g=>g.family===r.family&&g.ruleId===r.rule.id)}));
 return {from:{revision:before.revision,sha256:knowledgeHash(before)},to:{revision:after.revision,sha256:knowledgeHash(after)},concepts:changes(before.concepts,after.concepts,c=>c.id),rules:changes(rules(before),rules(after),r=>r.id),forms:{before:before.concepts.reduce((n,c)=>n+1+c.aliases.length,0),after:after.concepts.reduce((n,c)=>n+1+c.aliases.length,0)},activated:false};
}
export async function readOperatorSnapshot(client:Pick<PoolClient,'query'>,releaseId?:string,limit=25){
 integer(String(limit),25,1,100);
 if(releaseId!==undefined&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(releaseId))throw new Error('Invalid release UUID');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SET LOCAL statement_timeout='10s'");
  if(releaseId){
   const row=(await client.query('SELECT id,fingerprint,artifact FROM release.dictionaries WHERE id=$1',[releaseId])).rows[0];
   if(!row)throw new Error('Unknown release');
   return {releaseId:row.id,fingerprint:row.fingerprint,dictionary:row.artifact as Dictionary};
  }
  const rows=(await client.query(`SELECT i.id,i.status,i.expected_fingerprint,i.release_id,i.created_at,i.updated_at,
   (i.manifest->>'concepts')::integer AS expected_concepts,jsonb_array_length(i.manifest->'chunks') AS expected_chunks,
   coalesce(c.completed_concepts,0)::integer AS completed_concepts,coalesce(c.completed_chunks,0)::integer AS completed_chunks,
   coalesce(c.uploaded_bytes,0)::bigint AS uploaded_bytes
   FROM knowledge.bulk_imports i LEFT JOIN LATERAL
   (SELECT sum(record_count) AS completed_concepts,count(*) AS completed_chunks,sum(byte_count) AS uploaded_bytes FROM knowledge.bulk_chunks WHERE import_id=i.id) c ON true
   ORDER BY i.created_at DESC,i.id LIMIT $1`,[limit])).rows;
  return {readOnly:true,limit,rows};
 }finally{await client.query('ROLLBACK');}
}
export async function runKnowledgeCatalog(args:string[]){
 const {positionals,values}=parseArgs({args,allowPositionals:true,options:{dictionary:{type:'string'},'release-id':{type:'string'},pack:{type:'string'},query:{type:'string'},kind:{type:'string'},limit:{type:'string'},offset:{type:'string'}}});
 const command=positionals[0],limit=integer(values.limit,25,1,100),offset=integer(values.offset,0,0,100000);
 if(positionals.length!==1||!['search','diff','imports'].includes(command))throw new Error('Use search|diff|imports; no command mutates the database');
 if(command==='imports'){
  if(values.dictionary||values['release-id']||values.pack||values.query||values.kind||values.offset)throw new Error('imports accepts only --limit');
  if(!process.env.DATABASE_URL)throw new Error('Explicit operator DATABASE_URL required');
  return withDb(c=>readOperatorSnapshot(c,undefined,limit));
 }
 if(Boolean(values.dictionary)===Boolean(values['release-id']))throw new Error('Choose exactly one --dictionary or --release-id');
 if(command==='diff'&&!values.pack||command==='search'&&values.pack)throw new Error('Only diff requires --pack');
 let dictionary:Dictionary;
 if(values.dictionary)dictionary=JSON.parse((await boundedRead(values.dictionary,32*1024*1024)).toString('utf8'));
 else{
  if(!process.env.DATABASE_URL)throw new Error('Explicit operator DATABASE_URL required');
  const result=await withDb(c=>readOperatorSnapshot(c,values['release-id']));
  if(!('dictionary' in result)||!result.dictionary)throw new Error('Missing release dictionary');dictionary=result.dictionary;
 }
 return withDictionaryRecognition(dictionary,async()=>{
  const pack=canonicalKnowledge(dictionary.languageKnowledge);
  return command==='search'?searchKnowledge(pack,values.query,values.kind,limit,offset):diffKnowledge(pack,canonicalKnowledge(JSON.parse((await boundedRead(values.pack!,32*1024*1024)).toString('utf8'))));
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await runKnowledgeCatalog(process.argv.slice(2)),null,2));}finally{await closeDb();}}
