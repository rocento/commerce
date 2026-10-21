/** Local rehearsal only. The general operator CLI has no automatic activation. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import pg from 'pg';
import {uploadBulkBundle,finalizeBulkImport,inspectBulkImport} from '../src/knowledge-bulk.ts';
import {projectKnowledge} from '../src/knowledge-store.ts';
import {knowledgeHash} from '../src/language-knowledge.ts';
const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5432'||url.pathname!=='/commerce_language')throw new Error('This rehearsal is restricted to local commerce_language on port 5432');
const out=resolve(import.meta.dirname,'../../../../output/enterprise-knowledge-expansion-20261010');
const candidate=JSON.parse(await readFile(join(out,'candidate.json'),'utf8'));
const {migrate,closeDb}=await import('../src/database.ts');await migrate();await closeDb();
const client=new pg.Client({connectionString:url.href,connectionTimeoutMillis:3000});await client.connect();
try{
 const active=async()=> (await client.query("SELECT d.id,d.fingerprint,d.dictionary_version,d.artifact FROM release.channels c JOIN release.dictionaries d ON d.id=c.release_id WHERE c.channel='production'")).rows[0];
 const before=await active();if(!before)throw new Error('Expected an existing local active release');
 const projected=projectKnowledge({...before.artifact,version:before.dictionary_version,corpus:[]},candidate.languageKnowledge);
 const {generationFingerprint:_fp,corpus:_corpus,...content}=projected.dictionary;
 if(knowledgeHash(content)!==candidate.generationFingerprint)throw new Error('Local base is incompatible with the evaluated candidate');
 const start=performance.now(),first=await uploadBulkBundle(client,join(out,'bundle'),before.fingerprint,2);
 const afterPause=await inspectBulkImport(client,first.id);
 const resumed=await uploadBulkBundle(client,join(out,'bundle'),before.fingerprint);
 const result=await finalizeBulkImport(client,first.id),repeat=await finalizeBulkImport(client,first.id);
 const stored=(await client.query('SELECT artifact,fingerprint FROM release.dictionaries WHERE id=$1',[result.releaseId])).rows[0];
 if(stored.fingerprint!==candidate.generationFingerprint||knowledgeHash(stored.artifact.languageKnowledge)!==knowledgeHash(candidate.languageKnowledge))throw new Error('Stored candidate differs from the frozen candidate');
 const after=await active();if(before.id!==after.id||before.fingerprint!==after.fingerprint)throw new Error('Active release changed');
 const counts=(await client.query('SELECT (SELECT count(*)::integer FROM knowledge.concepts WHERE pack_sha256=$1) AS concepts,(SELECT count(*)::integer FROM knowledge.aliases WHERE pack_sha256=$1) AS forms,(SELECT count(*)::integer FROM knowledge.rule_governance WHERE pack_sha256=$1) AS governed_rules',[result.packSha256])).rows[0];
 if(counts.concepts!==candidate.languageKnowledge.concepts.length||counts.forms!==candidate.languageKnowledge.concepts.reduce((n:number,c:any)=>n+1+c.aliases.length,0))throw new Error('Stored relational counts differ');
 const sizes=(await client.query("SELECT pg_database_size(current_database())::text AS database_bytes,pg_total_relation_size('knowledge.bulk_concepts')::text AS staging_concepts_bytes,pg_total_relation_size('knowledge.bulk_chunks')::text AS staging_chunks_bytes,pg_total_relation_size('knowledge.bulk_imports')::text AS staging_jobs_bytes")).rows[0];
 const report={scope:'Existing local shared commerce_language; inactive candidate only',active:{id:after.id,fingerprint:after.fingerprint,revision:after.artifact.languageKnowledge.revision},firstUpload:afterPause,resumed,result,repeatReusesCandidate:repeat.releaseId===result.releaseId,counts,sizes,elapsedMs:performance.now()-start,candidateFingerprint:stored.fingerprint,activated:false};
 await writeFile(join(out,'local-stage.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await client.end();}
