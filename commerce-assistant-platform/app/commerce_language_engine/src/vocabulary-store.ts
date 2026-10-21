/** Transactional additive import; immutable candidate release, no channel activation. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {projectVocabulary,vocabularyHash} from './vocabulary-enrichment.ts';
import type {Dictionary} from './types.ts';
import {registerCandidate} from './release-lifecycle.ts';

export async function importVocabulary(client:Pick<PoolClient,'query'>, input:unknown, options:{apply:boolean;expectedFingerprint:string}) {
  if(!options.expectedFingerprint)throw new Error('Expected base fingerprint is required');
  await client.query(options.apply?'BEGIN':'BEGIN READ ONLY');
  try {
    // Shared with existing dictionary writers; avoid racing activation/regeneration.
    await client.query('SELECT pg_advisory_xact_lock(57439)');
    const row=(await client.query("SELECT d.id,d.artifact,d.dictionary_version,d.fingerprint,d.corpus_gzip,d.manifest FROM release.channels c JOIN release.dictionaries d ON d.id=c.release_id WHERE c.channel='production'")).rows[0];
    if(!row || row.fingerprint!==options.expectedFingerprint)throw new Error('Active dictionary fingerprint mismatch');
    if(!row.corpus_gzip)throw new Error('Active release requires archived corpus');
    const base={...row.artifact,version:row.dictionary_version,generationFingerprint:row.fingerprint,corpus:[]} as Dictionary;
    const plan=projectVocabulary(base,input);
    const {generationFingerprint:_old,corpus:_corpus,...content}=plan.dictionary;
    const fingerprint=vocabularyHash(content);
    const artifact={...content,generationFingerprint:fingerprint};
    const summary={baseReleaseId:row.id,baseFingerprint:row.fingerprint,candidateFingerprint:fingerprint,packSha256:plan.packSha256,byGroup:plan.byGroup,added:plan.added.length,activated:false};
    // Same parent + reviewed pack always yields the same immutable staged release.
    const previous=(await client.query("SELECT id,fingerprint FROM release.dictionaries WHERE manifest->'vocabularyEnrichment'->>'packSha256'=$1 AND manifest->'vocabularyEnrichment'->>'baseReleaseId'=$2 ORDER BY created_at LIMIT 1",[plan.packSha256,String(row.id)])).rows[0];
    if(previous && previous.fingerprint!==fingerprint)throw new Error('Existing candidate content mismatch; use a new reviewed pack revision');
    // Preflight every association before any inserts. Never reactivate or overwrite a held meaning.
    for(const term of plan.added){
      const group=(await client.query('SELECT id FROM semantic.groups WHERE code=$1 AND active',[term.group])).rows[0];
      // Draft membership is carried by the immutable artifact, not shared semantic rows.
      const lexical=(await client.query('SELECT id,active,language_code FROM lexicon.terms WHERE normalized_term=$1',[term.surface])).rows[0];
      if(lexical && (!lexical.active || lexical.language_code!=='en'))throw new Error('Inactive or non-English lexical surface: '+term.surface);
      const links=(await client.query('SELECT g.code,t.active,t.industry_id FROM semantic.terms t JOIN semantic.groups g ON g.id=t.semantic_group_id JOIN lexicon.terms l ON l.id=t.lexicon_term_id WHERE l.normalized_term=$1',[term.surface])).rows;
      if(links.some(link=>!link.active || link.industry_id!==null || (link.code!==term.group&&!term.sharedWith.includes(link.code))))throw new Error('Unreviewed database sense conflict: '+term.surface);
      if((await client.query('SELECT 1 FROM entity.aliases a JOIN lexicon.terms l ON l.id=a.lexicon_term_id WHERE l.normalized_term=$1 LIMIT 1',[term.surface])).rowCount)throw new Error('Database entity alias needs separate review: '+term.surface);
      // A previous unactivated import may already own this pair. Its provenance must match.
      const existing=(await client.query('SELECT t.metadata FROM semantic.terms t JOIN lexicon.terms l ON l.id=t.lexicon_term_id WHERE t.semantic_group_id=$1 AND l.normalized_term=$2',[group?.id??null,term.surface])).rows[0];
      if(existing && existing.metadata?.vocabularyPackSha256!==plan.packSha256)throw new Error('Existing association belongs to another revision: '+term.surface);
    }
    if(!options.apply || previous || !plan.added.length){
      await client.query('ROLLBACK');
      return {...summary,applied:false,releaseId:previous?.id??null};
    }
    const releaseId=randomUUID();
    const manifest={...row.manifest,source:plan.pack.source,fingerprint,counts:{...row.manifest.counts,semanticTerms:artifact.groups.reduce((n,g)=>n+g.terms.length,0),distinctNormalizedTerms:new Set(artifact.groups.flatMap(g=>g.terms)).size},vocabularyEnrichment:summary};
    await client.query('INSERT INTO release.dictionaries(id,dictionary_version,fingerprint,schema_version,artifact,corpus_gzip,manifest) VALUES($1,$2,$3,$4,$5,$6,$7)',[releaseId,artifact.version,fingerprint,artifact.schemaVersion??2,artifact,row.corpus_gzip,manifest]);
    await registerCandidate(client,{releaseId,baseReleaseId:row.id,artifact,archive:row.corpus_gzip,source:plan.pack.source,manifest,change:{kind:'vocabulary-pack',key:plan.pack.id,payload:{pack:plan.pack,packSha256:plan.packSha256}}});
    await client.query('INSERT INTO utterance.generation_runs(dictionary_version,fingerprint,manifest,release_id,active) VALUES($1,$2,$3,$4,false)',[artifact.version,fingerprint,manifest,releaseId]);
    await client.query('COMMIT');
    return {...summary,applied:true,releaseId};
  } catch(error){await client.query('ROLLBACK');throw error;}
}
