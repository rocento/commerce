/** Offline regression quality and warm latency, never commerce/model execution. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
type Case={text:string;intent:string|null;status:string;edits:[string,string][];protected?:string[];price?:number};
const datasetBytes=await readFile(process.argv[3]??new URL('../data/english-corrections/safety-v1.json',import.meta.url));
const dataset=JSON.parse(datasetBytes.toString()) as {cases:Case[];cohort:string;limitations:string};
const dictionaryBytes=await readFile(new URL('../data/compiled.json',import.meta.url));
const compiled=compile(JSON.parse(dictionaryBytes.toString()));
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
let accepted=0,correct=0,expected=0,falseCorrectionCases=0,protectedErrors=0,frameCorrect=0;
const failures:{text:string;issues:string[]}[]=[];
for(const c of dataset.cases){
 const result=resolve(compiled,c.text),changes=result.correctionEvidence?.candidates.filter(x=>x.accepted)??[];
 const issues:string[]=[];expected+=c.edits.length;accepted+=changes.length;
 const remaining=[...c.edits];let falseCorrection=false;
 for(const change of changes){
  const index=remaining.findIndex(([from,to])=>from===change.original&&to===change.candidate);
  if(index<0){falseCorrection=true;issues.push('unexpected accepted correction');}else{correct++;remaining.splice(index,1);}
  if([...c.text].slice(change.start,change.end).join('')!==change.original)issues.push('invalid original span');
 }
 if(falseCorrection)falseCorrectionCases++;
 if(remaining.length)issues.push('expected correction missing');
 for(const value of c.protected??[]){
  const offset=c.text.indexOf(value);if(offset<0)throw Error('Invalid protected fixture');
  const start=[...c.text.slice(0,offset)].length,end=start+[...value].length;
  if(changes.some(change=>change.start<end&&change.end>start)||!(result.interpretationText??c.text).includes(value)){
   protectedErrors++;issues.push('protected field changed');
  }
 }
 if(result.text!==c.text)issues.push('original text changed');
 const frame=result.intent===c.intent&&result.status===c.status&&(c.price===undefined||result.entities.price?.value===c.price);
 if(frame)frameCorrect++;else issues.push(`frame: ${result.status}/${result.intent}`);
 if(issues.length)failures.push({text:c.text,issues});
}
// Warm each request before measurement; exclude loading/compilation and filesystem writes.
for(const c of dataset.cases)resolve(compiled,c.text);
const times:number[]=[];
for(let pass=0;pass<20;pass++)for(const c of dataset.cases){const start=performance.now();resolve(compiled,c.text);times.push(performance.now()-start);}
times.sort((a,b)=>a-b);
const report={cohort:dataset.cohort,limitations:dataset.limitations,datasetSha256:sha(datasetBytes),dictionarySha256:sha(dictionaryBytes),node:process.version,
 cases:dataset.cases.length,expectedCorrections:expected,acceptedCorrections:accepted,correctCorrections:correct,
 correctionPrecision:accepted?correct/accepted:null,correctionRecall:expected?correct/expected:null,
 falseCorrectionCases,falseCorrectionRate:falseCorrectionCases/dataset.cases.length,protectedErrors,
 frameCorrect,frameAccuracy:frameCorrect/dataset.cases.length,
 latency:{kind:'warm resolver, local serial process',samples:times.length,p50Ms:times[Math.ceil(times.length*.5)-1],p95Ms:times[Math.ceil(times.length*.95)-1]},failures};
const output=process.argv[2];if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));if(failures.length)process.exitCode=1;
