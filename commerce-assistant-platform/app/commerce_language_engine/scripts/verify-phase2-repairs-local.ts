/** Read-only verification of an inactive local candidate and its relational records. */
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
import {knowledgeHash} from '../src/language-knowledge.ts';
const out=new URL('../../../../output/enterprise-knowledge-phase2-fixes-20261010/',import.meta.url);
const imported=JSON.parse(await readFile(new URL('local-candidate.json',out),'utf8'));
const expected=JSON.parse(await readFile(new URL('candidate.json',out),'utf8'));
const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
try{
 const active=(await client.query("SELECT d.id,d.fingerprint,d.artifact->'languageKnowledge'->>'revision' AS revision FROM release.channels c JOIN release.dictionaries d ON d.id=c.release_id WHERE c.channel='production'")).rows[0];
 assert.equal(active.id,imported.baseReleaseId);assert.equal(active.fingerprint,imported.baseFingerprint);assert.notEqual(active.id,imported.releaseId);
 const candidate=(await client.query('SELECT id,fingerprint,artifact FROM release.dictionaries WHERE id=$1',[imported.releaseId])).rows[0];
 const pack=candidate.artifact.languageKnowledge;
 assert.equal(candidate.fingerprint,expected.generationFingerprint);assert.equal(knowledgeHash(pack),imported.packSha256);assert.deepEqual(pack,expected.languageKnowledge);
 assert.deepEqual(candidate.artifact.entity_terms,expected.entity_terms);
 const concepts=(await client.query('SELECT code,kind,canonical,metadata FROM knowledge.concepts WHERE pack_sha256=$1',[imported.packSha256])).rows;
 assert.equal(concepts.length,pack.concepts.length);
 for(const c of pack.concepts){const stored=concepts.find(row=>row.code===c.id);assert.equal(stored.kind,c.kind);assert.equal(stored.canonical,c.canonical);assert.deepEqual(stored.metadata,c.metadata??{});}
 const rules=(await client.query('SELECT * FROM knowledge.rules WHERE pack_sha256=$1',[imported.packSha256])).rows;
 assert.equal(rules.length,pack.rules.length);
 for(const rule of pack.rules){const stored=rules.find(row=>row.code===rule.id);for(const [key,field] of Object.entries({marker:'marker',targetKind:'target_kind',relation:'relation',scope:'scope',priority:'priority'}))assert.equal(stored[field],rule[key]);assert.equal(stored.negated,!!rule.negated);assert.equal(stored.requires_clarification,!!rule.requiresClarification);assert.equal(stored.target_possessive,!!rule.targetPossessive);assert.equal(stored.clarify_alternatives,!!rule.clarifyAlternatives);assert.deepEqual(stored.target_metadata,rule.targetMetadata??null);}
 const governance=(await client.query('SELECT record FROM knowledge.rule_governance WHERE pack_sha256=$1',[imported.packSha256])).rows;
 assert.equal(governance.length,pack.ruleGovernance.length);assert.deepEqual(governance.map(r=>knowledgeHash(r.record)).sort(),pack.ruleGovernance.map(knowledgeHash).sort());
 const budgets=(await client.query('SELECT code,templates,output FROM knowledge.budget_rules WHERE pack_sha256=$1',[imported.packSha256])).rows;
 assert.equal(budgets.length,pack.budgetRules.length);for(const rule of pack.budgetRules){const row=budgets.find(r=>r.code===rule.id);assert.deepEqual(row.templates,rule.templates);assert.equal(row.output,rule.output);}
 const aliases=Number((await client.query('SELECT count(*) AS n FROM knowledge.aliases WHERE pack_sha256=$1',[imported.packSha256])).rows[0].n);
 const reviewedConcepts=Number((await client.query('SELECT count(DISTINCT concept_code) AS n FROM knowledge.lexical_reviews WHERE pack_code=$1 AND revision=$2 AND review IS NOT NULL',[pack.id,pack.revision])).rows[0].n);
 assert.equal(reviewedConcepts,pack.concepts.filter((c:any)=>c.metadata?.lexicalReview).length);
 const migration=(await client.query('SELECT max(filename) AS name FROM public.schema_migrations')).rows[0].name;
 assert.equal(migration,'030_person_composition_policy.sql');
 const report={verifiedAt:new Date().toISOString(),scope:'Local commerce_language only; no activation or production connection',active,candidate:{id:candidate.id,fingerprint:candidate.fingerprint,revision:pack.revision,packSha256:imported.packSha256},migration,counts:{concepts:concepts.length,conceptForms:aliases,reviewedConcepts,relationshipRules:rules.length,budgetRules:budgets.length,governedRules:governance.length},recordContentVerified:true,activated:false};
 await writeFile(new URL('local-state.json',out),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await client.end();}
