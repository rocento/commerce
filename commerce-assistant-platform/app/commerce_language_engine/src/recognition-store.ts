import type {PoolClient} from 'pg';
import {compileRecognitionRules,type RecognitionRules} from './recognition-rules.ts';
/** Persist exactly the release's recognition snapshot inside its transaction. */
export async function persistRecognitionRules(client:Pick<PoolClient,'query'>,releaseId:string,rules:RecognitionRules|undefined):Promise<void>{
 const runtime=compileRecognitionRules(rules);
 await client.query(`INSERT INTO release.recognition_rules(release_id,code,kind,definition)
 SELECT $1,entry.key,entry.value->>'kind',entry.value FROM jsonb_each($2::jsonb) entry`,[releaseId,JSON.stringify(runtime.rules.entries)]);
}
