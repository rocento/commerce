/** Relational projection of the exact immutable pack; caller owns transaction. */
import type {PoolClient} from 'pg';
import {canonicalKnowledge,knowledgeHash} from './language-knowledge.ts';
import {normalize} from './normalize.ts';
export async function persistKnowledgePack(client:Pick<PoolClient,'query'>,input:unknown){
 const pack=canonicalKnowledge(input),packSha256=knowledgeHash(pack);
 const stored=(await client.query('SELECT sha256 FROM knowledge.packs WHERE code=$1 AND revision=$2',[pack.id,pack.revision])).rows[0];
 if(stored){if(stored.sha256!==packSha256)throw new Error('Stored knowledge revision differs; use a new revision');return;}
 const aliases=new Map<string,string>();for(const c of pack.concepts)for(const surface of [c.canonical,...c.aliases])if(!aliases.has(normalize(surface)))aliases.set(normalize(surface),surface);
 const lexical=(await client.query('SELECT normalized_term,active,language_code FROM lexicon.terms WHERE normalized_term=ANY($1::text[])',[[...aliases.keys()]])).rows;
 for(const term of lexical)if(!term.active||term.language_code!=='en')throw new Error('Inactive or non-English lexical surface: '+term.normalized_term);

   await client.query('INSERT INTO knowledge.packs(sha256,code,revision,schema_version,language_code,source) VALUES($1,$2,$3,1,\'en\',$4)',[packSha256,pack.id,pack.revision,pack.source]);
   // Batch insert avoids a query for each word as packs grow. Existing lexical IDs stay stable.
   await client.query("INSERT INTO lexicon.terms(term,normalized_term,language_code) SELECT x.surface,x.normalized,'en' FROM jsonb_to_recordset($1::jsonb) AS x(surface text,normalized text) ON CONFLICT(normalized_term) DO NOTHING",[JSON.stringify([...aliases].map(([normalized,surface])=>({normalized,surface})))]);
   await client.query('INSERT INTO knowledge.concepts(pack_sha256,code,kind,canonical,metadata) SELECT $1,x.id,x.kind,x.canonical,coalesce(x.metadata,\'{}\'::jsonb) FROM jsonb_to_recordset($2::jsonb) AS x(id text,kind text,canonical text,metadata jsonb)',[packSha256,JSON.stringify(pack.concepts)]);
   const associations=pack.concepts.flatMap(c=>[...new Map([c.canonical,...c.aliases].map(surface=>[normalize(surface),surface])).entries()].map(([normalized,surface])=>({concept:c.id,normalized,surface,isCanonical:normalized===normalize(c.canonical)})));
   await client.query('INSERT INTO knowledge.aliases(pack_sha256,concept_code,lexicon_term_id,surface,is_canonical) SELECT $1,x.concept,l.id,x.surface,x."isCanonical" FROM jsonb_to_recordset($2::jsonb) AS x(concept text,normalized text,surface text,"isCanonical" boolean) JOIN lexicon.terms l ON l.normalized_term=x.normalized',[packSha256,JSON.stringify(associations)]);
   await client.query('INSERT INTO knowledge.rules(pack_sha256,code,marker,target_kind,relation,scope,priority,target_metadata,negated,requires_clarification,target_possessive,clarify_alternatives) SELECT $1,x.id,x.marker,x."targetKind",x.relation,x.scope,x.priority,x."targetMetadata",coalesce(x.negated,false),coalesce(x."requiresClarification",false),coalesce(x."targetPossessive",false),coalesce(x."clarifyAlternatives",false) FROM jsonb_to_recordset($2::jsonb) AS x(id text,marker text,"targetKind" text,relation text,scope text,priority integer,"targetMetadata" jsonb,negated boolean,"requiresClarification" boolean,"targetPossessive" boolean,"clarifyAlternatives" boolean)',[packSha256,JSON.stringify(pack.rules)]);
   if(pack.utteranceRules?.length)await client.query('INSERT INTO knowledge.utterance_rules(pack_sha256,code,role,phrases,preference,reference) SELECT $1,x.id,x.role,x.phrases,x.preference,x.reference FROM jsonb_to_recordset($2::jsonb) AS x(id text,role text,phrases jsonb,preference text,reference text)',[packSha256,JSON.stringify(pack.utteranceRules)]);
   if(pack.questionRules?.length)await client.query('INSERT INTO knowledge.question_rules(pack_sha256,code,intent,templates) SELECT $1,x.id,x.intent,x.templates FROM jsonb_to_recordset($2::jsonb) AS x(id text,intent text,templates jsonb)',[packSha256,JSON.stringify(pack.questionRules)]);

 if(pack.budgetRules?.length)await client.query('INSERT INTO knowledge.budget_rules(pack_sha256,code,templates,priority,output,scope) SELECT $1,x.id,x.templates,x.priority,x.output,x.scope FROM jsonb_to_recordset($2::jsonb) AS x(id text,templates jsonb,priority integer,output text,scope text)',[packSha256,JSON.stringify(pack.budgetRules)]);
 if(pack.ruleGovernance?.length)await client.query("INSERT INTO knowledge.rule_governance(pack_sha256,family,rule_code,rule_version,definition_sha256,record) SELECT $1,x.value->>'family',x.value->>'ruleId',(x.value->>'version')::integer,x.value->>'definitionSha256',x.value FROM jsonb_array_elements($2::jsonb) AS x(value)",[packSha256,JSON.stringify(pack.ruleGovernance)]);
}
