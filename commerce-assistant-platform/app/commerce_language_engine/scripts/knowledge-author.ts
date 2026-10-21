/** Reviewed alias edits create immutable draft revisions; publication stays separate. */
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import type {PoolClient} from 'pg';
import {boundedRead} from '../src/knowledge-bulk.ts';
import {canonicalKnowledge,knowledgeHash,type LanguageKnowledgePack} from '../src/language-knowledge.ts';
import {withDictionaryRecognition} from '../src/recognition-rules.ts';
import {projectKnowledge} from '../src/knowledge-store.ts';
import {reviseReleaseDraft} from '../src/release-lifecycle.ts';
import {withDb,closeDb} from '../src/database.ts';
import {diffKnowledge} from './knowledge-catalog.ts';
import type {Dictionary} from '../src/types.ts';

type Edit={conceptId:string;add?:string[];remove?:string[]};
export type KnowledgeEdit={schemaVersion:1;expectedPackSha256:string;nextRevision:number;actor:string;reason:string;source:string;reviewer:string;reviewMethod:'human'|'ai_assisted';reviewedAt:string;edits:Edit[]};
const nonempty=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=2000;
export function editAliases(dictionary:Dictionary,input:KnowledgeEdit){
 return withDictionaryRecognition(dictionary,()=>{
  if(!input||Object.keys(input).some(k=>!['schemaVersion','expectedPackSha256','nextRevision','actor','reason','source','reviewer','reviewMethod','reviewedAt','edits'].includes(k))||input.schemaVersion!==1||!['actor','reason','source','reviewer'].every(k=>nonempty(input[k as keyof KnowledgeEdit]))||!['human','ai_assisted'].includes(input.reviewMethod)||!Number.isFinite(Date.parse(input.reviewedAt))||!Array.isArray(input.edits)||!input.edits.length||input.edits.length>100)throw Error('Invalid reviewed edit request');
  const before=canonicalKnowledge(dictionary.languageKnowledge);
  if(knowledgeHash(before)!==input.expectedPackSha256)throw Error('Pack changed; reload before editing');
  if(input.nextRevision!==before.revision+1)throw Error('Next knowledge revision must increment by one');
  const pack:LanguageKnowledgePack=structuredClone(before);pack.revision=input.nextRevision;
  const seen=new Set<string>();
  for(const edit of input.edits){
   if(!edit||Object.keys(edit).some(k=>!['conceptId','add','remove'].includes(k))||seen.has(edit.conceptId)||!Array.isArray(edit.add??[])||!Array.isArray(edit.remove??[])||!(edit.add?.length||edit.remove?.length)||[...(edit.add??[]),...(edit.remove??[])].some(x=>!nonempty(x)))throw Error('Invalid or duplicate concept edit');
   seen.add(edit.conceptId);const concept=pack.concepts.find(c=>c.id===edit.conceptId);if(!concept)throw Error('Unknown concept: '+edit.conceptId);
   for(const alias of edit.remove??[])if(!concept.aliases.includes(alias))throw Error('Cannot retire missing alias: '+alias);
   for(const alias of edit.add??[])if(concept.aliases.includes(alias)||alias===concept.canonical)throw Error('Alias already exists: '+alias);
   if((edit.add??[]).some(a=>edit.remove?.includes(a)))throw Error('Conflicting add/remove');
   concept.aliases=[...concept.aliases.filter(a=>!edit.remove?.includes(a)),...(edit.add??[])].sort();
   concept.metadata={...concept.metadata,domains:concept.metadata?.domains??['commerce'],usage:concept.metadata?.usage??'explicit_relationship_only'};
   delete concept.metadata.lexicalReview;
   concept.metadata.lexicalReview={source:input.source,author:input.actor,reviewer:input.reviewer,method:input.reviewMethod,status:'reviewed',reviewedAt:input.reviewedAt,formsSha256:knowledgeHash({kind:concept.kind,canonical:concept.canonical,aliases:concept.aliases}),contentSha256:knowledgeHash(concept)};
  }
  // Existing validators enforce normalized collisions, ambiguity declarations,
  // lexical provenance, rule contracts, and compilation before any DB write.
  const projected=projectKnowledge(dictionary,pack);
  return {...projected,diff:diffKnowledge(before,projected.pack)};
 });
}
export async function authorDraft(client:Pick<PoolClient,'query'>,draftId:string,expectedRevision:number,input:KnowledgeEdit,apply=false){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(draftId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw Error('Explicit draft UUID and revision required');
 const row=(await client.query('SELECT artifact,corpus_gzip,manifest FROM release.draft_revisions WHERE draft_id=$1 AND revision=$2',[draftId,expectedRevision])).rows[0];
 if(!row)throw Error('Unknown draft revision');
 const result=editAliases(row.artifact,input);
 if(!apply)return {applied:false,draftId,expectedRevision,...result.diff};
 const corpus=gunzipSync(row.corpus_gzip,{maxOutputLength:256*1024*1024}).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const revision=await reviseReleaseDraft(client,{draftId,expectedRevision,dictionary:result.dictionary,corpus,manifest:row.manifest,change:{kind:'reviewed-knowledge-alias-edit',key:knowledgeHash(input),payload:{...input,diff:result.diff}}});
 return {...revision,applied:true,activated:false,packSha256:result.packSha256,diff:result.diff};
}
export async function runKnowledgeAuthor(args:string[]){
 const {positionals,values}=parseArgs({args,allowPositionals:true,options:{'draft-id':{type:'string'},revision:{type:'string'},edits:{type:'string'},apply:{type:'boolean',default:false}}});
 if(positionals.length||!values['draft-id']||!values.edits||!values.revision||!process.env.DATABASE_URL)throw Error('Use --draft-id UUID --revision N --edits FILE [--apply], with explicit DATABASE_URL; default is preview');
 const input=JSON.parse((await boundedRead(values.edits,1024*1024)).toString('utf8'));
 return withDb(c=>authorDraft(c,values['draft-id']!,Number(values.revision),input,values.apply));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await runKnowledgeAuthor(process.argv.slice(2)),null,2));}finally{await closeDb();}}
