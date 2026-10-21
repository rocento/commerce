import {createReadStream} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {evaluateCalibration, type Prediction} from '../src/evaluation/calibration.ts';
import type {CorpusCase} from '../src/types.ts';
import {promotionBlockers} from '../src/artifact-promotion.ts';

const minimumSamples=Number(process.env.CALIBRATION_MIN_SAMPLES??30);
if(!Number.isInteger(minimumSamples)||minimumSamples<10)throw new Error('CALIBRATION_MIN_SAMPLES must be an integer of at least 10');
const runtime=await loadRuntime(),generation=JSON.parse(await readFile('data/generation-report.json','utf8'));
if(generation.version!==runtime.dictionary.version||generation.fingerprint!==runtime.dictionary.generationFingerprint)throw new Error('Corpus and dictionary versions differ; regenerate and compile together.');
const corpusHash=createHash('sha256');
async function* cases(){for await(const line of createInterface({input:createReadStream('data/corpus.jsonl'),crlfDelay:Infinity})){if(!line.trim())continue;corpusHash.update(line+'\n');yield JSON.parse(line) as CorpusCase;}}
const development:Prediction[]=[],heldout:Prediction[]=[];
let excludedCompound=0;
for await(const test of cases()){
 if(test.split!=='development'&&test.split!=='test')continue;
 const result=resolve(runtime,test.text,test.context),predicted=result.status==='RESOLVED'?result.intent:null;
 // Compound confidence is synthesized, not empirically scored.
 if(result.requestType==='COMPOUND'||(result.clauses?.length??0)>1){excludedCompound++;continue;}
 (test.split==='development'?development:heldout).push({expected:test.intent,predicted,confidence:result.confidence});
}
const diagnostic=evaluateCalibration(development,heldout,new Map(runtime.dictionary.intents.map(i=>[i.code,i.family])),runtime.dictionary.version,minimumSamples);
const {calibrations}=diagnostic;
const developmentCount=development.filter(r=>r.predicted!==null).length,testCount=heldout.length;
const brierRegressed=diagnostic.heldout.calibrated.brierScore>diagnostic.heldout.raw.brierScore;
const evaluationPassed=diagnostic.heldout.raw.count>0&&calibrations.length>0&&!brierRegressed;
const artifact={schemaVersion:2,dictionaryVersion:runtime.dictionary.version,generationFingerprint:generation.fingerprint,createdAt:new Date().toISOString(),method:'ISOTONIC',minimumSamples,runtimePromotion:'DISABLED',evaluationGate:{brierScoreRegressed:brierRegressed,passed:evaluationPassed},provenance:{source:'generated-corpus',sampleCount:developmentCount,split:'development',evaluationSplit:'test',corpusSha256:corpusHash.digest('hex'),warning:'Synthetic generator-derived corpus; not production-user feedback. Compound semantic-graph requests are excluded because their current confidence is not scored empirically.'},calibrations};
const promotionBlockersNow=promotionBlockers(artifact,{dictionaryVersion:runtime.dictionary.version,generationFingerprint:generation.fingerprint},['CREATE_ORDER','CHECKOUT','CANCEL_ORDER']);
if(!promotionBlockersNow.includes('artifact_explicitly_disabled'))throw new Error('Diagnostic calibration was unexpectedly eligible for promotion.');
const report={...artifact,counts:{development:developmentCount,test:testCount,calibratedFamilies:calibrations.length,excludedCompound},heldout:diagnostic.heldout,abstentions:diagnostic.abstentions,limitations:['Synthetic held-out corpus does not establish production precision.', 'Calibration is diagnostic only; routing and clarification thresholds are unchanged.', 'Compound semantic graph confidence is excluded pending an empirically grounded graph confidence signal.', 'Brier/ECE measure resolved intent predictions only; abstentions are counted separately. Family selection uses the predicted intent in development and held-out evaluation.']};
await writeFile('data/confidence-calibration.json',JSON.stringify(artifact,null,2)+'\n');
await writeFile('data/confidence-evaluation.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({counts:report.counts,raw:report.heldout.raw,calibrated:report.heldout.calibrated,calibratedFamilies:calibrations.map(c=>({family:c.scopeCode,samples:c.sampleCount})),limitations:report.limitations},null,2));
