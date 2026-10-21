import {createHash} from 'node:crypto';
import {acceptanceV3} from '../tests/acceptance-v3.ts';
import {createReadStream} from 'node:fs';
import {writeFile,readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {isDeepStrictEqual} from 'node:util';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {holdout} from '../tests/corpus.ts';
import {acceptance} from '../tests/acceptance-corpus.ts';

import type {CorpusCase} from '../src/types.ts';
if(process.argv.includes('--database'))throw new Error('Use npm run release:evaluate -- --release-id <uuid> to record an evaluation of an exact immutable candidate. The general evaluator is diagnostic only.');
const c=await loadRuntime();
type Totals={count:number;intent:number;status:number;known:number;top3:number;high:number;highCorrect:number;unknown:number;falsePositive:number;unknownOutput:number;ambiguous:number;ambiguousCorrect:number;context:number;contextCorrect:number;entityFields:number;entityCorrect:number;entityRecords:number;entityRecordsCorrect:number};
const empty=():Totals=>({count:0,intent:0,status:0,known:0,top3:0,high:0,highCorrect:0,unknown:0,falsePositive:0,unknownOutput:0,ambiguous:0,ambiguousCorrect:0,context:0,contextCorrect:0,entityFields:0,entityCorrect:0,entityRecords:0,entityRecordsCorrect:0});
const ratio=(a:number,b:number)=>b?Math.round(a/b*10000)/10000:null;
const metrics=(t:Totals)=>({count:t.count,intentAccuracy:ratio(t.intent,t.count),statusAccuracy:ratio(t.status,t.count),top3IntentAccuracy:ratio(t.top3,t.known),entityExtractionAccuracy:ratio(t.entityCorrect,t.entityFields),entityChecks:t.entityFields,entityRecordAccuracy:ratio(t.entityRecordsCorrect,t.entityRecords),highConfidenceAccuracy:ratio(t.highCorrect,t.high),highConfidenceCount:t.high,ambiguityDetectionAccuracy:ratio(t.ambiguousCorrect,t.ambiguous),contextDependentAccuracy:ratio(t.contextCorrect,t.context),falsePositiveRate:ratio(t.falsePositive,t.unknown),unknownQueryRate:ratio(t.unknownOutput,t.count)});
async function run(cases:Iterable<CorpusCase>|AsyncIterable<CorpusCase>) {
 const total=empty();const groups=new Map<string,Totals>();const failures:unknown[]=[];let failureCount=0;
 for await(const test of cases) {
  const result=resolve(c,test.text,test.context);const expectedStatus=test.status??'RESOLVED';
  const keys=['difficulty:'+test.difficulty,'split:'+(test.split??'manual'),'intent:'+(test.intent??'<ABSTAIN>')];
  const buckets=[total,...keys.map(k=>{if(!groups.has(k))groups.set(k,empty());return groups.get(k)!;})];
  for(const t of buckets) {
   t.count++;if(result.intent===test.intent)t.intent++;if(result.status===expectedStatus)t.status++;
   if(test.intent){t.known++;if(result.debug.candidates.slice(0,3).some(x=>x.intent===test.intent))t.top3++;}
   if(result.confidenceLevel==='HIGH'){t.high++;if(result.intent===test.intent)t.highCorrect++;}
   if(expectedStatus==='UNKNOWN'){t.unknown++;if(result.status==='RESOLVED')t.falsePositive++;}
   if(result.status==='UNKNOWN')t.unknownOutput++;
   if(expectedStatus==='AMBIGUOUS'){t.ambiguous++;if(result.status==='AMBIGUOUS')t.ambiguousCorrect++;}
   if(test.difficulty==='CONTEXT_REQUIRED'){t.context++;if(result.intent===test.intent&&result.status===expectedStatus)t.contextCorrect++;}
   if(test.source==='constrained-catalog-v2'){t.entityRecords++;if(isDeepStrictEqual(result.entities,test.entities))t.entityRecordsCorrect++;}
   for(const [key,value] of Object.entries(test.entities??{})){t.entityFields++;if(isDeepStrictEqual(result.entities[key],value))t.entityCorrect++;}
  }
  const entityErrors=Object.entries(test.entities??{}).filter(([key,value])=>!isDeepStrictEqual(result.entities[key],value)).map(([key])=>key);
  if(result.intent!==test.intent||result.status!==expectedStatus||entityErrors.length){failureCount++;if(failures.length<80)failures.push({text:test.text,expected:test.intent,actual:result.intent,status:result.status,expectedStatus,entityErrors});}
 }
 const grouped=(prefix:string)=>Object.fromEntries([...groups].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k.slice(prefix.length),metrics(v)]));
 const perIntent=[...groups].filter(([k])=>k.startsWith('intent:')&&k!=='intent:<ABSTAIN>').map(([,v])=>v.intent/v.count);
 return {overall:{...metrics(total),macroIntentAccuracy:perIntent.length?perIntent.reduce((a,b)=>a+b,0)/perIntent.length:null},byDifficulty:grouped('difficulty:'),bySplit:grouped('split:'),byIntent:grouped('intent:'),failureCount,failures,failuresTruncated:failureCount>failures.length};
}
async function* generatedCases(){for await(const line of createInterface({input:createReadStream('data/corpus.jsonl'),crlfDelay:Infinity}))if(line.trim())yield JSON.parse(line) as CorpusCase;}
const generation=JSON.parse(await readFile('data/generation-report.json','utf8'));
if(generation.version!==c.dictionary.version||generation.fingerprint!==c.dictionary.generationFingerprint)throw new Error('Corpus and dictionary versions differ; regenerate and compile together.');
const baseline=JSON.parse(await readFile('tests/fixtures/acceptance-v3-baseline.json','utf8'));
const freshCorpusHash=createHash('sha256').update(JSON.stringify(acceptanceV3)).digest('hex');
if(freshCorpusHash!==baseline.corpusHash)throw new Error('Frozen acceptance corpus changed');
const start=performance.now();
const report={createdAt:new Date().toISOString(),dictionaryVersion:c.dictionary.version,generationFingerprint:generation.fingerprint,warning:'Synthetic corpus is generator-derived and search-heavy. Development examples were used in prior debugging. Acceptance v1 is now a development regression set. Acceptance v3 was frozen before this iteration, with a v2 baseline. Both are authored, small, and not real-user validation.',canonical:await run(c.dictionary.corpus),development:await run(holdout),generated:await run(generatedCases()),acceptance:await run(acceptance),freshAcceptance:await run(acceptanceV3),freshBaseline:{corpusHash:baseline.corpusHash,count:baseline.count,intentAccuracy:baseline.intentCorrect/baseline.count,statusAccuracy:baseline.statusCorrect/baseline.count},evaluationMs:performance.now()-start};
await writeFile('data/evaluation.json',JSON.stringify(report,null,2));

console.log(JSON.stringify({canonical:report.canonical.overall,development:report.development.overall,generated:report.generated.overall,generatedFailures:report.generated.failureCount,acceptance:report.acceptance.overall,acceptanceFailures:report.acceptance.failures,freshAcceptance:report.freshAcceptance.overall,freshBaseline:report.freshBaseline,freshFailures:report.freshAcceptance.failures,evaluationMs:report.evaluationMs},null,2));
