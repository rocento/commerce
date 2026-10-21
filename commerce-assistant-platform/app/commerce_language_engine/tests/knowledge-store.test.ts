import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
/** PostgreSQL test creates a disposable DB; never points the importer at the application DB. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {stageRelease,bootstrapRelease,loadRelease,recordReleaseEvaluation,promoteRelease,rollbackRelease} from '../src/release-lifecycle.ts';
import pg from 'pg';
import {importLanguageKnowledge,projectKnowledge} from '../src/knowledge-store.ts';
import {knowledgeHash,type LanguageKnowledgePack} from '../src/language-knowledge.ts';
import {ruleContract,reviewContentHash} from '../src/rule-governance.ts';
const exec=promisify(execFile);
const databaseUrl=process.env.LANGUAGE_KNOWLEDGE_TEST_DATABASE_URL;
const input=(recognitionFixture(JSON.parse(await readFile(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const {languageKnowledge:_knowledge,...base}=input;
const {generationFingerprint:_legacyFingerprint,corpus:_baselineCorpus,...baselineContent}=base;
base.generationFingerprint=knowledgeHash(baselineContent);
const pack:LanguageKnowledgePack={schemaVersion:1,id:'storage-test',revision:1,language:'en',source:'reviewed storage test',concepts:[{id:'person.mother',kind:'person',canonical:'mother',aliases:['mom'],metadata:{personRole:'recipient'}},{id:'activity.classes',kind:'activity',canonical:'online classes',aliases:[]},{id:'device.phone',kind:'device',canonical:'iPhone 13',aliases:['iphone thirteen']}],rules:[{id:'person-for',marker:'for',targetKind:'person',relation:'recipient',scope:'product',priority:80,targetMetadata:{personRole:'recipient'}},{id:'activity-for',marker:'for',targetKind:'activity',relation:'intended_use',scope:'product',priority:80},{id:'device-for',marker:'for',targetKind:'device',relation:'compatibility_target',scope:'product',priority:80}],utteranceRules:[{id:'response.short',role:'response_preference',phrases:['keep the answer short'],preference:'short'},{id:'budget.current',role:'budget_update',phrases:['my budget is {amount} now']},{id:'response.two_options',role:'response_preference',phrases:['show two suitable options'],preference:'two_options'},{id:'response.one_question',role:'response_preference',phrases:['ask me one narrowing question'],preference:'one_question'},{id:'followup.first',role:'recommendation_followup',phrases:['i do not like the first suggestion what is another option'],reference:'FIRST'}]};
pack.questionRules=[{id:'question.price',intent:'CHECK_PRICE',templates:['what is the current price of {product}']}];
pack.utteranceRules!.push({id:'lead_in.question',role:'lead_in',phrases:['quick question']});
test('knowledge import preserves lexical IDs, stages atomically, is idempotent and leaves rollback available',{skip:!databaseUrl,timeout:120000},async t=>{
 const admin=new pg.Client({connectionString:databaseUrl}),name='knowledge_'+randomUUID().replaceAll('-','');let client:pg.Client|undefined,created=false;
 await admin.connect();
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  const url=new URL(databaseUrl!);url.pathname='/'+name;client=new pg.Client({connectionString:url.href});await client.connect();
  const migrations=new URL('../migrations/',import.meta.url);
  await client.query('CREATE TABLE public.schema_migrations(filename text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort()){const sql=await readFile(new URL(f,migrations),'utf8');await client.query(sql);await client.query('INSERT INTO public.schema_migrations(filename,sha256) VALUES($1,$2)',[f,createHash('sha256').update(sql).digest('hex')]);}
  const corpus=gzipSync(Buffer.from('{"text":"baseline corpus"}\n'));
  const baseline=await stageRelease(client,{dictionary:{...base,corpus:[]},corpus:[{text:'baseline corpus'} as any],corpusArchive:corpus,baseReleaseId:null,source:'knowledge-test-bootstrap'}),id=baseline.releaseId;
  await bootstrapRelease(client,{releaseId:id,actor:'test',reason:'disposable fixture'});
  await client.query("INSERT INTO lexicon.terms(term,normalized_term,language_code) VALUES('mother','mother','en')");
  const lexicalId=(await client.query("SELECT id FROM lexicon.terms WHERE normalized_term='mother'")).rows[0].id;
  const snapshot=async()=>({utteranceRules:(await client!.query('SELECT * FROM knowledge.utterance_rules ORDER BY code')).rows,packs:(await client!.query('SELECT * FROM knowledge.packs ORDER BY sha256')).rows,concepts:(await client!.query('SELECT * FROM knowledge.concepts ORDER BY code')).rows,aliases:(await client!.query('SELECT * FROM knowledge.aliases ORDER BY concept_code,lexicon_term_id')).rows,lexicon:(await client!.query('SELECT * FROM lexicon.terms ORDER BY id')).rows,releases:(await client!.query('SELECT id,fingerprint FROM release.dictionaries ORDER BY id')).rows,channels:(await client!.query('SELECT * FROM release.channels')).rows});
  const initial=await snapshot(),opts={apply:true,expectedFingerprint:base.generationFingerprint};
  await t.test('dry run and stale base do not mutate data',async()=>{
   const dry=await importLanguageKnowledge(client!,pack,{...opts,apply:false});assert.equal(dry.applied,false);assert.deepEqual(await snapshot(),initial);
   await assert.rejects(importLanguageKnowledge(client!,pack,{...opts,expectedFingerprint:'stale'}),/fingerprint/);assert.deepEqual(await snapshot(),initial);
  });
  const applied=await importLanguageKnowledge(client,pack,opts);assert.equal(applied.applied,true);assert.equal(applied.activated,false);
  await t.test('staging leaves the active channel and old IDs unchanged',async()=>{
   assert.equal((await client!.query("SELECT release_id FROM release.channels WHERE channel='production'")).rows[0].release_id,id);
   assert.equal((await client!.query("SELECT id FROM lexicon.terms WHERE normalized_term='mother'")).rows[0].id,lexicalId);
   assert.equal((await client!.query('SELECT count(*) AS n FROM entity.aliases')).rows[0].n,'0');
   assert.equal((await client!.query('SELECT count(*) AS n FROM knowledge.utterance_rules WHERE pack_sha256=$1',[applied.packSha256])).rows[0].n,String(pack.utteranceRules!.length));
   assert.deepEqual((await client!.query('SELECT intent,templates FROM knowledge.question_rules WHERE pack_sha256=$1',[applied.packSha256])).rows,[{intent:'CHECK_PRICE',templates:['what is the current price of {product}']}]);
   assert.equal((await client!.query("SELECT reference FROM knowledge.utterance_rules WHERE pack_sha256=$1 AND code='followup.first'",[applied.packSha256])).rows[0].reference,'FIRST');
   assert.equal((await client!.query("SELECT kind FROM knowledge.concepts WHERE pack_sha256=$1 AND code='device.phone'",[applied.packSha256])).rows[0].kind,'device');
   const stored=(await client!.query('SELECT artifact,corpus_gzip FROM release.dictionaries WHERE id=$1',[applied.releaseId])).rows[0];assert.deepEqual(stored.artifact.languageKnowledge,projectKnowledge(base,pack).pack);assert.deepEqual(stored.corpus_gzip,corpus);
   const {corpus:_corpus,generationFingerprint:_fingerprint,...content}=projectKnowledge(base,pack).dictionary;assert.equal(applied.candidateFingerprint,knowledgeHash(content));
  });
  await t.test('repeated imports reuse the immutable candidate',async()=>{
   const before=await snapshot(),again=await importLanguageKnowledge(client!,{...pack,concepts:[...pack.concepts].reverse()},opts);assert.equal(again.releaseId,applied.releaseId);assert.equal(again.applied,false);assert.deepEqual(await snapshot(),before);
   await assert.rejects(importLanguageKnowledge(client!,{...pack,source:'edited revision'},opts),/revision/);assert.deepEqual(await snapshot(),before);
  });
  await t.test('failure after relational inserts rolls back the entire pack and release',async()=>{
   await client!.query("CREATE FUNCTION knowledge.fail_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected candidate failure'; END $$");
   await client!.query('CREATE TRIGGER test_failure BEFORE INSERT ON release.dictionaries FOR EACH ROW EXECUTE FUNCTION knowledge.fail_candidate()');
   try{const before=await snapshot();await assert.rejects(importLanguageKnowledge(client!,{...pack,revision:2},opts),/injected candidate failure/);assert.deepEqual(await snapshot(),before);}finally{await client!.query('DROP TRIGGER test_failure ON release.dictionaries');await client!.query('DROP FUNCTION knowledge.fail_candidate()');}
  });
  await t.test('held lexical entries are not reactivated',async()=>{
   await client!.query("INSERT INTO lexicon.terms(term,normalized_term,active) VALUES('held term','held term',false)");
   const held={...pack,revision:3,concepts:[...pack.concepts,{id:'activity.held',kind:'activity',canonical:'held term',aliases:[]}]},before=await snapshot();await assert.rejects(importLanguageKnowledge(client!,held,opts),/Inactive/);assert.deepEqual(await snapshot(),before);
  });
  await t.test('active pack is a no-op and original release remains available for rollback',async()=>{
   const frozen=await loadRelease(client!,applied.releaseId),runtimeSha256='a'.repeat(64),rubricVersion='knowledge-regression-v1',contractVersion='2';
   const evaluationId=await recordReleaseEvaluation(client!,{releaseId:applied.releaseId,artifactSha256:frozen.artifactSha256,corpusSha256:frozen.corpusSha256,runtimeSha256,rubricVersion,contractVersion,passed:true,report:{cases:1}});
   await promoteRelease(client!,{releaseId:applied.releaseId,evaluationId,expectedActiveReleaseId:id,runtimeSha256,rubricVersion,contractVersion,actor:'test',reason:'knowledge activation test'});
   const again=await importLanguageKnowledge(client!,pack,{apply:true,expectedFingerprint:applied.candidateFingerprint});assert.equal(again.releaseId,applied.releaseId);assert.equal(again.applied,false);
   await rollbackRelease(client!,{releaseId:id,expectedActiveReleaseId:applied.releaseId,actor:'test',reason:'rollback rehearsal'});assert.equal((await client!.query('SELECT artifact FROM release.dictionaries WHERE id=$1',[id])).rows[0].artifact.languageKnowledge,undefined);
   await assert.rejects(client!.query('UPDATE knowledge.utterance_rules SET phrases=$1 WHERE pack_sha256=$2',[JSON.stringify(['changed']),applied.packSha256]),/immutable/);
   await assert.rejects(client!.query('UPDATE knowledge.packs SET source=$1 WHERE sha256=$2',['changed',applied.packSha256]),/immutable/);
   await assert.rejects(client!.query('UPDATE knowledge.question_rules SET templates=$1 WHERE pack_sha256=$2',[JSON.stringify(['changed']),applied.packSha256]),/immutable/);
  });
  await t.test('governed records are immutable, drafts cannot promote, and all candidate paths prevent downgrade',async()=>{
   const governed=JSON.parse(await readFile(new URL('../data/knowledge/shopping-en-governed-v1.json',import.meta.url),'utf8')) as LanguageKnowledgePack;
   const candidate=await importLanguageKnowledge(client!,governed,opts);
   assert.equal(candidate.activated,false);
   const rows=(await client!.query('SELECT family,rule_code,rule_version,record FROM knowledge.rule_governance WHERE pack_sha256=$1',[candidate.packSha256])).rows;
   assert.equal(rows.length,governed.ruleGovernance!.length);
   assert.equal((await client!.query('SELECT count(*) AS n FROM knowledge.rule_reviews WHERE pack_sha256=$1',[candidate.packSha256])).rows[0].n,String(rows.length));
   assert.equal((await client!.query('SELECT jsonb_array_length(templates) AS n FROM knowledge.budget_rules WHERE pack_sha256=$1',[candidate.packSha256])).rows[0].n,30);
   for(const table of ['rule_governance','budget_rules'])await assert.rejects(client!.query(`DELETE FROM knowledge.${table} WHERE pack_sha256=$1`,[candidate.packSha256]),/immutable/);
   const row=structuredClone(governed.ruleGovernance![0]);row.ruleId='nonexistent';
   await assert.rejects(client!.query('INSERT INTO knowledge.rule_governance(pack_sha256,family,rule_code,rule_version,definition_sha256,record) VALUES($1,$2,$3,$4,$5,$6)',[candidate.packSha256,row.family,row.ruleId,row.version,row.definitionSha256,row]),/unknown rule/);
   const evidence=async(releaseId:string)=>{const frozen=await loadRelease(client!,releaseId);return recordReleaseEvaluation(client!,{releaseId,artifactSha256:frozen.artifactSha256,corpusSha256:frozen.corpusSha256,runtimeSha256:'a'.repeat(64),rubricVersion:'governance-test-v1',contractVersion:'2',passed:true,report:{scope:'Test-only synthetic promotion evidence'}});};
   const promotion={runtimeSha256:'a'.repeat(64),rubricVersion:'governance-test-v1',contractVersion:'2',actor:'test',reason:'disposable governance test',expectedActiveReleaseId:id};
   const draft=structuredClone(governed);draft.revision++;draft.ruleGovernance![0].status='draft';delete draft.ruleGovernance![0].review;
   const stagedDraft=await importLanguageKnowledge(client!,draft,opts);
   const draftEvaluation=await evidence(stagedDraft.releaseId);
   await assert.rejects(promoteRelease(client!,{...promotion,releaseId:stagedDraft.releaseId,evaluationId:draftEvaluation}),/reviewed knowledge/);
   await client!.query('BEGIN');
   try{
    // Rehearse an old operator writing a syntactically valid activation directly.
    await client!.query("INSERT INTO release.activations(channel,release_id,previous_release_id,evaluation_id,actor,reason,operation) VALUES('production',$1,$2,$3,'test','old operator test','promotion')",[stagedDraft.releaseId,id,draftEvaluation]);
    await assert.rejects(client!.query("UPDATE release.channels SET release_id=$1 WHERE channel='production'",[stagedDraft.releaseId]),/reviewed knowledge/);
   }finally{await client!.query('ROLLBACK');}
   assert.equal((await client!.query("SELECT release_id FROM release.channels WHERE channel='production'")).rows[0].release_id,id);
   await promoteRelease(client!,{...promotion,releaseId:candidate.releaseId,evaluationId:await evidence(candidate.releaseId)});
   const changed=structuredClone(governed);changed.revision+=2;changed.budgetRules![0].priority++;
   const budget=changed.ruleGovernance!.find(r=>r.family==='budget')!;budget.definitionSha256=knowledgeHash(changed.budgetRules![0]);budget.contract=ruleContract('budget',changed.budgetRules![0]);budget.review!.contentSha256=reviewContentHash(budget);
   await assert.rejects(importLanguageKnowledge(client!,changed,{apply:true,expectedFingerprint:candidate.candidateFingerprint}),/new version/);
   await assert.rejects(stageRelease(client!,{dictionary:base,corpus:[],baseReleaseId:candidate.releaseId,source:'attempt to strip governance'}),/removed or downgraded/);
   await rollbackRelease(client!,{releaseId:id,expectedActiveReleaseId:candidate.releaseId,actor:'test',reason:'governance rollback rehearsal'});
  });
  await t.test('Phase 2 stores scoped lexical reviews, polarity, ranges and a v2 activation/rollback',async()=>{
   const phase2=JSON.parse(await readFile(new URL('../data/knowledge/shopping-en-phase2-v1.json',import.meta.url),'utf8'));
   phase2.id='phase2-storage-test'; // Separate from deliberate revision-collision fixtures above.
   const candidate=await importLanguageKnowledge(client!,phase2,opts);
   assert.equal(candidate.activated,false);
   const records=(await client!.query('SELECT code,negated,requires_clarification FROM knowledge.rules WHERE pack_sha256=$1',[candidate.packSha256])).rows;
   for(const rule of phase2.rules){const row=records.find(r=>r.code===rule.id);assert.equal(row.negated,!!rule.negated);assert.equal(row.requires_clarification,!!rule.requiresClarification);}
   const lexical=(await client!.query('SELECT DISTINCT concept_code,review,domains,usage FROM knowledge.lexical_reviews WHERE pack_code=$1 AND revision=7 AND review IS NOT NULL',[phase2.id])).rows;
   assert.equal(lexical.length,phase2.concepts.filter((c:any)=>c.metadata?.lexicalReview).length);
   for(const row of lexical){const c=phase2.concepts.find((c:any)=>c.id===row.concept_code);assert.deepEqual(row.review,c.metadata.lexicalReview);assert.deepEqual(row.domains,c.metadata.domains);}
   assert.equal((await client!.query("SELECT output FROM knowledge.budget_rules WHERE pack_sha256=$1 AND code='budget.inline.range'",[candidate.packSha256])).rows[0].output,'price_range');
   assert.deepEqual((await loadRelease(client!,candidate.releaseId)).dictionary.languageKnowledge,projectKnowledge(base,phase2).pack);
   const frozen=await loadRelease(client!,candidate.releaseId),runtimeSha256='b'.repeat(64),rubricVersion='phase2-storage-test',contractVersion='2';
   const evaluationId=await recordReleaseEvaluation(client!,{releaseId:candidate.releaseId,artifactSha256:frozen.artifactSha256,corpusSha256:frozen.corpusSha256,runtimeSha256,rubricVersion,contractVersion,passed:true,report:{scope:'Disposable storage test only'}});
   await promoteRelease(client!,{releaseId:candidate.releaseId,evaluationId,expectedActiveReleaseId:id,runtimeSha256,rubricVersion,contractVersion,actor:'test',reason:'disposable v2 activation'});
   await rollbackRelease(client!,{releaseId:id,expectedActiveReleaseId:candidate.releaseId,actor:'test',reason:'v2 rollback rehearsal'});
   const repaired=JSON.parse(await readFile(new URL('../data/knowledge/shopping-en-phase2-v2.json',import.meta.url),'utf8'));repaired.id=phase2.id;
   const next=await importLanguageKnowledge(client!,repaired,opts);
   const policies=(await client!.query('SELECT code,target_possessive,clarify_alternatives,requires_clarification FROM knowledge.rules WHERE pack_sha256=$1',[next.packSha256])).rows;
   for(const rule of repaired.rules){const row=policies.find(r=>r.code===rule.id);assert.equal(row.target_possessive,!!rule.targetPossessive);assert.equal(row.clarify_alternatives,!!rule.clarifyAlternatives);assert.equal(row.requires_clarification,!!rule.requiresClarification);}
   assert.deepEqual((await loadRelease(client!,next.releaseId)).dictionary.languageKnowledge,projectKnowledge(base,repaired).pack);
   const nextFrozen=await loadRelease(client!,next.releaseId);
   const nextEvaluation=await recordReleaseEvaluation(client!,{releaseId:next.releaseId,artifactSha256:nextFrozen.artifactSha256,corpusSha256:nextFrozen.corpusSha256,runtimeSha256,rubricVersion,contractVersion,passed:true,report:{scope:'Disposable v3 policy storage test only'}});
   await promoteRelease(client!,{releaseId:next.releaseId,evaluationId:nextEvaluation,expectedActiveReleaseId:id,runtimeSha256,rubricVersion,contractVersion,actor:'test',reason:'disposable v3 activation'});
   await rollbackRelease(client!,{releaseId:id,expectedActiveReleaseId:next.releaseId,actor:'test',reason:'v3 rollback rehearsal'});
  });
  // Startup verification and explicit bundle bootstrap are covered in db-release-export.test.ts.
 }finally{if(client)await client.end();if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
});
