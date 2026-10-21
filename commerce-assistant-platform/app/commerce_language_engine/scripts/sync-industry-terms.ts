import {withDictionaryRecognition} from '../src/recognition-rules.ts';
import {withDb,closeDb} from '../src/database.ts';
import {currentReleaseId,loadRelease,stageRelease} from '../src/release-lifecycle.ts';
import {industryTerms} from '../src/generation/industry-terms.ts';
import {normalize} from '../src/normalize.ts';
import type {Dictionary} from '../src/types.ts';

// Apply this source to one immutable baseline; shared rows never become a draft.
try{
 const result=await withDb(async c=>{
  const baseReleaseId=await currentReleaseId(c);
  if(!baseReleaseId)throw new Error('An active immutable baseline is required. Bootstrap an initial reviewed release first.');
  const baseline=await loadRelease(c,baseReleaseId),dictionary:Dictionary=structuredClone(baseline.dictionary);
  return withDictionaryRecognition(dictionary,async()=>{
  let inserted=0,existing=0;
  for(const term of industryTerms){
   const prior=dictionary.entity_terms.find(row=>row.type===term.type&&normalize(row.alias)===normalize(term.alias)&&row.industry===term.industry);
   if(prior){if(prior.value!==term.value)throw new Error('Existing term needs explicit review: '+term.alias);existing++;}
   else {dictionary.entity_terms.push({...term});inserted++;}
  }
  if(!process.argv.includes('--apply'))return {apply:false,baseReleaseId,inserted,existing};
  return {apply:true,activated:false,inserted,existing,...await stageRelease(c,{dictionary,corpus:baseline.dictionary.corpus,baseReleaseId,source:'sync-industry-terms',change:{kind:'entity-terms',key:'industry-terms',payload:{inserted,existing}}})};
  });
 });
 console.log(JSON.stringify(result,null,2));
}finally{await closeDb();}
