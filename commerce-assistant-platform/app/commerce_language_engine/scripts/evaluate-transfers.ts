import {writeFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {closeDb,loadDictionary,withDb} from '../src/database.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {transferSource} from '../src/generation/transfer-cases.ts';
try {
 const dictionary=await loadDictionary(),compiled=compile(dictionary);
 const cases=await withDb(async db=>(await db.query(`SELECT u.text,i.code AS intent,u.expected_status AS status,u.expected_entities AS entities,u.context,u.split
 FROM utterance.generated u LEFT JOIN intent.definitions i ON i.id=u.expected_intent_id WHERE u.source=$1 ORDER BY u.id`,[transferSource])).rows);
 if(!cases.length)throw new Error('No transfer cases in the database; run generate first.');
 const failures:unknown[]=[],bySplit:Record<string,number>={};
 for(const c of cases){
  const r=resolve(compiled,c.text,c.context??{});bySplit[c.split]=(bySplit[c.split]??0)+1;
  if(r.status!==c.status||r.intent!==c.intent||!Object.entries(c.entities??{}).every(([key,value])=>isDeepStrictEqual(r.entities[key],value)))failures.push({text:c.text,expected:c,actual:{status:r.status,intent:r.intent,entities:r.entities}});
 }
 const report={source:transferSource,generationFingerprint:dictionary.generationFingerprint,cases:cases.length,passed:cases.length-failures.length,failed:failures.length,bySplit,failures:failures.slice(0,25),limitations:'Authored synthetic regressions, not independent customer-language validation. Resolution does not execute cart changes.'};
 await writeFile('data/transfer-evaluation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 if(failures.length)process.exitCode=1;
}finally{await closeDb();}
