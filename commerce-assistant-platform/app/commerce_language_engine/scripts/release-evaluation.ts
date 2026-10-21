import {isDeepStrictEqual} from 'node:util';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {resolutionEnvelope} from '../src/resolution-wire.ts';
import type {CorpusCase,Dictionary} from '../src/types.ts';

// A deliberately explicit first release gate. Do not tune this rubric in place:
// a future change needs a new version and reevaluation of the frozen candidate.
export const RELEASE_RUBRIC_VERSION='commerce-language-release-v1';
export function evaluateReleaseCandidate(dictionary:Dictionary,corpus:CorpusCase[],identity:{releaseId:string|null;runtimeSha256:string}){
 if(!corpus.length)throw new Error('A release evaluation requires a nonempty archived corpus.');
 const runtime=compile({...dictionary,corpus:[]});
 const failures:unknown[]=[];
 let failureCount=0,wireFailureCount=0;
 for(const test of corpus){
  const actual=resolve(runtime,test.text,test.context);
  let wireError:string|undefined;
  try{resolutionEnvelope({...actual},{releaseId:identity.releaseId,generationFingerprint:dictionary.generationFingerprint!,runtimeVersion:identity.runtimeSha256,normalizationVersion:'english-v1',clauseSpanEncoding:'utf-16-code-units',evidenceSpanEncoding:'unicode-code-points'});}catch(error){wireError=error instanceof Error?error.message:String(error);wireFailureCount++;}
  const entityErrors=Object.entries(test.entities??{}).filter(([key,value])=>!isDeepStrictEqual(actual.entities[key],value)).map(([key])=>key);
  if(actual.intent!==test.intent||actual.status!==(test.status??'RESOLVED')||entityErrors.length||wireError){
   failureCount++;
   if(failures.length<80)failures.push({text:test.text,expectedIntent:test.intent,actualIntent:actual.intent,expectedStatus:test.status??'RESOLVED',actualStatus:actual.status,entityErrors,wireError});
  }
 }
 return {rubricVersion:RELEASE_RUBRIC_VERSION,passed:failureCount===0,count:corpus.length,failureCount,wireFailureCount,failures,failuresTruncated:failureCount>failures.length,checks:{compiles:true,allWireResponsesValid:wireFailureCount===0,allArchivedExpectationsPass:failureCount===0},warning:'This gate validates the frozen archived development corpus. It is not a measure of production customer accuracy.'};
}
