import {withDictionaryRecognition} from './recognition-rules.ts';
/** Additive reviewed knowledge import; explicit activation is a separate operation. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {compile} from './compiler.ts';
import {normalize} from './normalize.ts';
import {canonicalKnowledge,knowledgeHash} from './language-knowledge.ts';
import type {Dictionary} from './types.ts';
import {persistKnowledgePack} from './knowledge-pack-store.ts';
import {assertKnowledgeUpgrade} from './rule-governance.ts';
import {registerCandidate} from './release-lifecycle.ts';

type Client=Pick<PoolClient,'query'>;
export function projectKnowledge(base:Dictionary,input:unknown){
 return withDictionaryRecognition(base,()=>{
 const pack=canonicalKnowledge(input),packSha256=knowledgeHash(pack),dictionary=structuredClone({...base,corpus:base.corpus??[]});
 if(dictionary.languageKnowledge){
  const previous=canonicalKnowledge(dictionary.languageKnowledge);
  if(previous.id!==pack.id)throw new Error('A different active knowledge pack requires explicit consolidation');
  if(pack.revision<previous.revision)throw new Error('Knowledge revision cannot move backwards during import');
  if(pack.revision===previous.revision&&knowledgeHash(previous)!==packSha256)throw new Error('Changed knowledge content requires a new revision');
 }
 assertKnowledgeUpgrade(dictionary.languageKnowledge,pack);
 const unchanged=!!dictionary.languageKnowledge&&knowledgeHash(canonicalKnowledge(dictionary.languageKnowledge))===packSha256;
 dictionary.languageKnowledge=pack;
 compile(dictionary);
 const byKind:Record<string,number>={};for(const c of pack.concepts)byKind[c.kind]=(byKind[c.kind]??0)+1;
 return {dictionary,pack,packSha256,byKind,unchanged};

 });
}
export async function importLanguageKnowledge(client:Client,input:unknown,options:{apply:boolean;expectedFingerprint:string}){
 if(!options.expectedFingerprint)throw new Error('Expected base fingerprint is required');
 // Validate against the immutable base release before writing candidate data.
 await client.query(options.apply?'BEGIN':'BEGIN READ ONLY');
 try{
  await client.query('SELECT pg_advisory_xact_lock(57439)');
  const row=(await client.query("SELECT d.id,d.artifact,d.dictionary_version,d.fingerprint,d.corpus_gzip,d.manifest FROM release.channels c JOIN release.dictionaries d ON d.id=c.release_id WHERE c.channel='production'")).rows[0];
  if(!row||row.fingerprint!==options.expectedFingerprint)throw new Error('Active dictionary fingerprint mismatch');
  if(!row.corpus_gzip)throw new Error('Active release requires archived corpus');
  return await withDictionaryRecognition(row.artifact,async()=>{
  const plan=projectKnowledge({...row.artifact,version:row.dictionary_version,generationFingerprint:row.fingerprint,corpus:[]} as Dictionary,input);
  const {generationFingerprint:_old,corpus:_corpus,...content}=plan.dictionary;
  const fingerprint=plan.unchanged?row.fingerprint:knowledgeHash(content),artifact={...content,generationFingerprint:fingerprint};
  const aliases=new Map<string,string>();for(const c of plan.pack.concepts)for(const surface of [c.canonical,...c.aliases])if(!aliases.has(normalize(surface)))aliases.set(normalize(surface),surface);
  const summary={baseReleaseId:row.id,baseFingerprint:row.fingerprint,candidateFingerprint:fingerprint,packSha256:plan.packSha256,packId:plan.pack.id,revision:plan.pack.revision,concepts:plan.pack.concepts.length,aliases:aliases.size,rules:plan.pack.rules.length,utteranceRules:plan.pack.utteranceRules?.length??0,questionRules:plan.pack.questionRules?.length??0,questionTemplates:plan.pack.questionRules?.reduce((n,r)=>n+r.templates.length,0)??0,utterancePhrases:plan.pack.utteranceRules?.reduce((n,r)=>n+r.phrases.length,0)??0,byKind:plan.byKind,activated:false};
  const previous=(await client.query("SELECT id,fingerprint FROM release.dictionaries WHERE manifest->'languageKnowledge'->>'packSha256'=$1 AND manifest->'languageKnowledge'->>'baseReleaseId'=$2 ORDER BY created_at LIMIT 1",[plan.packSha256,String(row.id)])).rows[0];
  if(previous&&previous.fingerprint!==fingerprint)throw new Error('Existing knowledge candidate content mismatch');
  const stored=(await client.query('SELECT sha256 FROM knowledge.packs WHERE code=$1 AND revision=$2',[plan.pack.id,plan.pack.revision])).rows[0];
  if(stored&&stored.sha256!==plan.packSha256)throw new Error('Stored knowledge revision differs; use a new revision');
  const lexical=(await client.query('SELECT normalized_term,active,language_code FROM lexicon.terms WHERE normalized_term=ANY($1::text[])',[[...aliases.keys()]])).rows;
  for(const term of lexical)if(!term.active||term.language_code!=='en')throw new Error('Inactive or non-English lexical surface: '+term.normalized_term);
  if(!options.apply||previous||plan.unchanged){await client.query('ROLLBACK');return {...summary,applied:false,releaseId:plan.unchanged?row.id:previous?.id??null};}
  await persistKnowledgePack(client,plan.pack);
  const releaseId=randomUUID(),manifest={...row.manifest,source:plan.pack.source,fingerprint,languageKnowledge:summary,counts:{...row.manifest?.counts,knowledgeConcepts:plan.pack.concepts.length,knowledgeAliases:aliases.size,knowledgeRules:plan.pack.rules.length,knowledgeUtteranceRules:plan.pack.utteranceRules?.length??0,knowledgeQuestionRules:plan.pack.questionRules?.length??0}};
  await client.query('INSERT INTO release.dictionaries(id,dictionary_version,fingerprint,schema_version,artifact,corpus_gzip,manifest) VALUES($1,$2,$3,$4,$5,$6,$7)',[releaseId,artifact.version,fingerprint,artifact.schemaVersion??2,artifact,row.corpus_gzip,manifest]);
  await registerCandidate(client,{releaseId,baseReleaseId:row.id,artifact,archive:row.corpus_gzip,source:plan.pack.source,manifest,change:{kind:'knowledge-pack',key:plan.pack.id,payload:{packSha256:plan.packSha256,revision:plan.pack.revision}}});
  await client.query('INSERT INTO utterance.generation_runs(dictionary_version,fingerprint,manifest,release_id,active) VALUES($1,$2,$3,$4,false)',[artifact.version,fingerprint,manifest,releaseId]);
  await client.query('COMMIT');
  return {...summary,applied:true,releaseId};
  });
 }catch(error){await client.query('ROLLBACK');throw error;}
}
