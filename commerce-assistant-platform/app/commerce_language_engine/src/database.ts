import {withDictionaryRecognition} from './recognition-rules.ts';
import {rocentoDictionary,compatibleCase} from './rocento-capabilities.ts';
import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {normalize} from './normalize.ts';
import type {Dictionary,CorpusCase} from './types.ts';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {stageRelease,currentReleaseId,promoteRelease,bootstrapRelease,rollbackRelease,type PromotionOptions} from './release-lifecycle.ts';
export const databaseUrl=process.env.DATABASE_URL??'postgres://commerce:commerce@localhost:57439/commerce_language';
const poolMax=Number(process.env.CLE_DB_POOL_MAX??10);
if(!Number.isInteger(poolMax)||poolMax<1||poolMax>50)throw new Error('CLE_DB_POOL_MAX must be an integer from 1 to 50');
const pool=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,max:poolMax});
export async function closeDb(){await pool.end();}
export async function withDb<T>(fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
 const client=await pool.connect();try{return await fn(client);}finally{client.release();}
}
export async function migrate(){await withDb(async c=>{
 await c.query('SELECT pg_advisory_lock(57439)');
 try {
 await c.query('CREATE TABLE IF NOT EXISTS public.schema_migrations(filename text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
 const files=(await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
 const oldFiles=files.filter(f=>Number(f.slice(0,3))<=10);
 const applied=await c.query('SELECT filename,sha256 FROM public.schema_migrations');
 if(applied.rowCount===0){
  const legacy=await c.query("SELECT to_regclass('public.commerce_intents') IS NOT NULL AS exists");
  if(legacy.rows[0].exists){
   const check=await c.query(`SELECT
    to_regclass('public.semantic_groups') IS NOT NULL AND
    to_regclass('public.semantic_terms') IS NOT NULL AND
    to_regclass('public.entity_terms') IS NOT NULL AND
    to_regclass('public.pending_clarification_sessions') IS NOT NULL AND
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='generated_utterances' AND column_name='template_family') AS ready`);
   if(!check.rows[0].ready)throw new Error('Existing database is only partially migrated. Back up and complete the legacy migrations before enabling migration history.');
   for(const file of oldFiles){const sql=await readFile(new URL('../migrations/'+file,import.meta.url),'utf8');const sha=createHash('sha256').update(sql).digest('hex');await c.query('INSERT INTO public.schema_migrations(filename,sha256) VALUES($1,$2)',[file,sha]);}
  }
 }
 for(const file of files){
  const sql=await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'),sha=createHash('sha256').update(sql).digest('hex');
  const previous=await c.query('SELECT sha256 FROM public.schema_migrations WHERE filename=$1',[file]);
  if(previous.rowCount){if(previous.rows[0].sha256!==sha)throw new Error(`Applied migration checksum changed: ${file}`);continue;}
  const body=sql.replace(/^\s*BEGIN\s*;?/i,'').replace(/COMMIT\s*;?\s*$/i,'');
  await c.query('BEGIN');try{await c.query(body);await c.query('INSERT INTO public.schema_migrations(filename,sha256) VALUES($1,$2)',[file,sha]);await c.query('COMMIT');}catch(error){await c.query('ROLLBACK');throw error;}
 }
 }finally{await c.query('SELECT pg_advisory_unlock(57439)');}
});}

/** Generation creates an isolated candidate; activation is always a separate explicit operation. */
export async function saveDictionary(d:Dictionary,corpus:CorpusCase[]=d.corpus,report:Record<string,unknown>={},options:{bootstrap?:boolean}={}) {
 d=rocentoDictionary(d);
 const codes=new Set(d.intents.map(i=>i.code));
 corpus=corpus.filter(c=>compatibleCase(c,codes));
 return withDb(async c=>{
  const baseReleaseId=await currentReleaseId(c);
  if(baseReleaseId){
   const base=(await c.query('SELECT artifact FROM release.dictionaries WHERE id=$1',[baseReleaseId])).rows[0].artifact;
   if(base.languageKnowledge&&!d.languageKnowledge)throw new Error('Dictionary regeneration would remove contextual knowledge; preserve it in the candidate or use an explicit reviewed draft');
  }
  const candidate=await stageRelease(c,{dictionary:d,corpus,baseReleaseId,source:String(report.source??'dictionary-generator'),manifest:report,change:{kind:'dictionary-snapshot',key:'dictionary',payload:{source:report.source??'dictionary-generator'}}});
  if(options.bootstrap)await bootstrapRelease(c,{releaseId:candidate.releaseId,actor:'dictionary-generator',reason:'Explicit initial database bootstrap'});
  return candidate;
 });
}
export async function activateDictionaryRelease(releaseId:string,options?:Omit<PromotionOptions,'releaseId'>){
 if(!options)throw new Error('Activation requires passing evaluation evidence, expected active release and runtime/rubric/contract identity; use promote-release or explicit bootstrap/rollback');
 return withDb(c=>promoteRelease(c,{...options,releaseId}));
}
export {bootstrapRelease,rollbackRelease};
export async function loadDictionary(options:{projectionOnly?:boolean}={}):Promise<Dictionary> {
 return withDb(async c=>{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
  const q=async(sql:string)=>(await c.query(sql)).rows;
  const releases=await q("SELECT d.artifact,d.corpus_gzip,d.dictionary_version,d.fingerprint FROM release.channels c JOIN release.dictionaries d ON d.id=c.release_id WHERE c.channel='production'");
  const activeRelease=options.projectionOnly?[]:releases;
  if(activeRelease.length){
   let corpus:CorpusCase[];
   if(activeRelease[0].corpus_gzip){const corpusText=gunzipSync(activeRelease[0].corpus_gzip).toString('utf8');corpus=corpusText.split('\n').filter(Boolean).map((line:string)=>JSON.parse(line));}
   else corpus=await q(`SELECT u.text,i.code AS intent,u.difficulty,u.context,u.expected_entities AS entities,u.expected_status AS status,u.split,u.template_family AS "templateFamily",u.source FROM utterance.generated u LEFT JOIN intent.definitions i ON i.id=u.expected_intent_id WHERE u.template_family IN ('canonical','legacy') ORDER BY u.id`);
   await c.query('COMMIT');return {...activeRelease[0].artifact,version:activeRelease[0].dictionary_version,generationFingerprint:activeRelease[0].fingerprint,corpus} as Dictionary;
  }
  const recognitionRules=releases[0]?.artifact?.recognitionRules;
  return await withDictionaryRecognition({recognitionRules},async()=>{
  const groupRecords=await q('SELECT g.id AS group_id,g.code,g.category,l.term,t.metadata AS term_metadata FROM semantic.groups g LEFT JOIN semantic.terms t ON t.semantic_group_id=g.id AND t.active LEFT JOIN lexicon.terms l ON l.id=t.lexicon_term_id AND l.active WHERE g.active ORDER BY g.id,l.normalized_term');
  const groupMap=new Map<number,Dictionary['groups'][number]>();
  for(const row of groupRecords){let group=groupMap.get(row.group_id);if(!group){group={code:row.code,category:row.category,terms:[]};groupMap.set(row.group_id,group);}if(row.term!==null){group.terms.push(row.term);if(row.term_metadata?.enrichment)(group.termMetadata??={})[normalize(row.term)]=row.term_metadata;}}
  const groups=[...groupMap.values()];
  const intents=await q('SELECT i.code,f.code AS family,i.description,i.risk_level AS "riskLevel",i.requires_confirmation AS "requiresConfirmation",i.action_type AS "actionType",i.metadata FROM intent.definitions i JOIN intent.families f ON f.id=i.family_id WHERE i.active ORDER BY i.code');
  const conditions=await q('SELECT i.code,r.code AS rule_code,g.code AS "group",x.kind,x.score,x.occurrences,x.proximity,a.code AS after,n.code AS near FROM intent.rule_conditions x JOIN intent.rules r ON r.id=x.rule_id JOIN intent.definitions i ON i.id=r.intent_id AND i.active JOIN semantic.groups g ON g.id=x.semantic_group_id AND g.active LEFT JOIN semantic.groups a ON a.id=x.after_group_id AND a.active LEFT JOIN semantic.groups n ON n.id=x.near_group_id AND n.active WHERE x.active AND r.active AND (x.after_group_id IS NULL OR a.id IS NOT NULL) AND (x.near_group_id IS NULL OR n.id IS NOT NULL) ORDER BY r.id,x.id');
  const conditionsByRule=new Map<string,unknown[]>();
  for(const row of conditions){const key=`${row.code}|${row.rule_code}`,bucket=conditionsByRule.get(key)??[];const {code,rule_code,after,near,proximity,...condition}=row;bucket.push({...condition,...(after?{after}:{}),...(near?{near}:{}),...(proximity!==null?{proximity}:{})});conditionsByRule.set(key,bucket);}
  const conditionsFor=(intent:string,rule:string)=>conditionsByRule.get(`${intent}|${rule}`)??[];
  const ruleRows=await q('SELECT i.code AS intent,r.code,r.required_states AS states FROM intent.rules r JOIN intent.definitions i ON i.id=r.intent_id AND i.active WHERE r.active ORDER BY r.id');
  const rulesByIntent=new Map<string,any[]>();
  for(const row of ruleRows){const bucket=rulesByIntent.get(row.intent)??[];bucket.push(row);rulesByIntent.set(row.intent,bucket);}
  const release=await q('SELECT dictionary_version,fingerprint FROM utterance.generation_runs WHERE active');
  if((release[0]?.dictionary_version??0)<5)throw new Error('Database dictionary predates entity separation. Run generate after migrating to rebuild semantic.terms and entity.terms.');
  const semanticModel={
   industryPacks:(await q('SELECT code FROM industry.packs WHERE active ORDER BY code')).map(r=>r.code),
   entityTypes:(await q('SELECT code FROM entity.types ORDER BY code')).map(r=>r.code),
   operators:(await q('SELECT code FROM semantic.operators ORDER BY code')).map(r=>r.code),
   intentSlots:await q('SELECT i.code AS intent,s.code,e.code AS "entityType",s.value_type AS "valueType",s.requirement,s.min_count AS "minCount",s.max_count AS "maxCount",s.clarification_rank AS "clarificationRank",s.resolution_strategy AS "resolutionStrategy",s.version,s.metadata FROM intent.slots s JOIN intent.definitions i ON i.id=s.intent_id LEFT JOIN entity.types e ON e.id=s.entity_type_id WHERE s.active ORDER BY i.code,s.clarification_rank,s.id'),
   semanticRelationships:await q('SELECT a.code AS source,r.relation_code AS relation,b.code AS target,p.code AS industry,r.weight,r.directional,r.version,r.metadata FROM semantic.relationships r JOIN semantic.groups a ON a.id=r.source_group_id JOIN semantic.groups b ON b.id=r.target_group_id LEFT JOIN industry.packs p ON p.id=r.industry_pack_id WHERE r.active ORDER BY a.code,r.relation_code,b.code'),
   compositionRules:await q('SELECT r.code,r.left_kind AS "leftKind",r.left_ref AS "leftRef",r.relation,r.right_kind AS "rightKind",r.right_ref AS "rightRef",r.output_kind AS "outputKind",r.output_template AS "outputTemplate",r.precedence,r.score,p.code AS industry,r.version FROM semantic.composition_rules r LEFT JOIN industry.packs p ON p.id=r.industry_pack_id WHERE r.active ORDER BY r.precedence,r.code'),
   actionFrameSlots:await q('SELECT f.code AS frame,s.role_code AS role,g.code AS "semanticGroup",e.code AS "entityType",s.requirement,s.cardinality,s.positional_hint AS "positionalHint",s.version FROM action.frame_slots s JOIN action.frames f ON f.id=s.action_frame_id LEFT JOIN semantic.groups g ON g.id=s.semantic_group_id LEFT JOIN entity.types e ON e.id=s.entity_type_id WHERE s.active ORDER BY f.code,s.role_code'),
   ambiguities:await q('SELECT a.normalized_term AS term,a.candidate_kind AS "candidateKind",a.candidate_ref AS "candidateRef",p.code AS industry,a.prior_weight AS "priorWeight",a.required_context AS "requiredContext",a.disambiguation_policy AS "disambiguationPolicy",a.version FROM semantic.ambiguities a LEFT JOIN industry.packs p ON p.id=a.industry_pack_id WHERE a.active ORDER BY a.normalized_term,a.candidate_kind,a.candidate_ref'),
   referenceRules:await q('SELECT r.code,g.code AS "referenceGroup",r.target_kind AS "targetKind",r.selection_strategy AS "selectionStrategy",r.constraints,r.precedence,r.version FROM context.reference_rules r JOIN semantic.groups g ON g.id=r.reference_group_id WHERE r.active ORDER BY r.precedence,r.code'),
   clarificationPolicies:await q('SELECT i.code AS intent,p.slot_code AS "slotCode",p.question_template AS "questionTemplate",p.candidate_mode AS "candidateMode",p.max_attempts AS "maxAttempts",p.priority,p.version,p.metadata FROM resolution.clarification_policies p JOIN intent.definitions i ON i.id=p.intent_id WHERE p.active ORDER BY p.priority,p.id'),
   confidenceCalibrations:await q('SELECT scope_kind AS "scopeKind",scope_code AS "scopeCode",dictionary_version AS "dictionaryVersion",method,parameters,sample_count AS "sampleCount",metrics FROM scoring.confidence_calibrations WHERE active ORDER BY dictionary_version,scope_kind,scope_code'),
   industryPackRelations:await q('SELECT a.code AS parent,b.code AS child,r.inherit_terms AS "inheritTerms",r.inherit_rules AS "inheritRules",r.inherit_entities AS "inheritEntities",r.inherit_relationships AS "inheritRelationships",r.precedence FROM industry.pack_relations r JOIN industry.packs a ON a.id=r.parent_pack_id JOIN industry.packs b ON b.id=r.child_pack_id ORDER BY r.precedence,a.code,b.code'),
  };
  const result:Dictionary={recognitionRules,version:release[0]?.dictionary_version??1,schemaVersion:2,semanticModel,generationFingerprint:release[0]?.fingerprint,requestPrefixes:(await q('SELECT phrase FROM lexicon.request_prefixes WHERE active ORDER BY id')).map(r=>r.phrase),actionFrames:await q('SELECT f.code,i.code AS intent,f.actions,f.targets,f.prepositions,f.excluded_objects AS "excludedObjects",f.selection_required AS "selectionRequired",f.sources FROM action.frames f JOIN intent.definitions i ON i.id=f.intent_id WHERE f.active ORDER BY f.id'),groups,intents:intents.map(i=>{const {metadata,...base}=i;return {...base,...metadata,conditions:conditionsFor(i.code,'primary'),actionType:i.actionType,alternativeRules:(rulesByIntent.get(i.code)??[]).filter(r=>r.code!=='primary').map(r=>({code:r.code,states:r.states,conditions:conditionsFor(i.code,r.code)}))};}) as Dictionary['intents'],entity_terms:await q('SELECT t.code AS type,l.term AS alias,v.canonical_value AS value,coalesce(p.code,\'CORE\') AS industry FROM entity.aliases a JOIN entity.terms v ON v.id=a.entity_value_id JOIN entity.types t ON t.id=v.entity_type_id JOIN lexicon.terms l ON l.id=a.lexicon_term_id LEFT JOIN industry.packs p ON p.id=COALESCE(a.industry_id,v.industry_id) WHERE a.active AND v.active AND l.active AND (p.id IS NULL OR p.active)'),transitions:await q('SELECT p.code AS "previousIntent",g.code AS "group",i.code AS intent,t.required_states AS states,t.boost FROM intent.transition_rules t JOIN intent.definitions p ON p.id=t.previous_intent_id JOIN intent.definitions i ON i.id=t.target_intent_id JOIN semantic.groups g ON g.id=t.semantic_group_id WHERE t.active AND p.active'),conflicts:(await q('SELECT i.code AS a,j.code AS b FROM intent.conflicts c JOIN intent.definitions i ON i.id=c.intent_id JOIN intent.definitions j ON j.id=c.conflicting_intent_id WHERE i.active AND j.active')).map(x=>[x.a,x.b]),patterns:await q('SELECT i.code AS intent,p.groups,p.score FROM lexicon.phrase_patterns p JOIN intent.definitions i ON i.id=p.intent_id WHERE p.active AND i.active'),corpus:await q('SELECT u.text,i.code AS intent,u.difficulty,u.context,u.expected_entities AS entities,u.expected_status AS status,u.split,u.template_family AS "templateFamily",u.source FROM utterance.generated u LEFT JOIN intent.definitions i ON i.id=u.expected_intent_id WHERE u.template_family IN (\'canonical\',\'legacy\')')};
  const activeKnowledge=(await q("SELECT d.artifact->'languageKnowledge' AS pack FROM release.channels c JOIN release.dictionaries d ON d.id=c.release_id WHERE c.channel='production'"))[0]?.pack;
  if(activeKnowledge)result.languageKnowledge=activeKnowledge;
  await c.query('COMMIT');return result;
  });
  }catch(error){await c.query('ROLLBACK');throw error;}
 });
}
/** Shared authoring rows cannot prove draft membership. Explicit snapshots replace projection publishing. */
export async function publishProjectionRelease(_source:string,_manifest:Record<string,unknown>={}):Promise<never>{
 throw new Error('Projection publishing is disabled: stage an explicit dictionary draft from an immutable base release, evaluate it, then promote it');
}
