// Read the authored corpus targets unchanged. Comparison correctness is reported
// separately from unrelated intent/status diagnostics in the general evaluator.
import {createReadStream} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import type {CorpusCase} from '../src/types.ts';

const runtime=await loadRuntime();
const report={dictionaryVersion:runtime.dictionary.version,generationFingerprint:runtime.dictionary.generationFingerprint,cases:0,operatorFailures:0,amountOrCurrencyFailures:0,intentOrStatusFailures:0,byOperator:{} as Record<string,{cases:number;operatorFailures:number}>,failures:[] as unknown[]};
for await(const line of createInterface({input:createReadStream('data/corpus.jsonl'),crlfDelay:Infinity})){
 if(!line.trim())continue;
 const row=JSON.parse(line) as CorpusCase;
 const expected=row.entities?.price as {operator?:string;value?:number;currency?:string}|undefined;
 if(!expected||!['<','<=','>','>=','='].includes(expected.operator??''))continue;
 const actual=resolve(runtime,row.text,row.context);
 const price=actual.entities.price;
 report.cases++;
 const bucket=report.byOperator[expected.operator!]??={cases:0,operatorFailures:0};
 bucket.cases++;
 const badOperator=price?.operator!==expected.operator;
 const badAmount=price?.value!==expected.value||price?.currency!==expected.currency;
 if(badOperator){report.operatorFailures++;bucket.operatorFailures++;}
 if(badAmount)report.amountOrCurrencyFailures++;
 if(actual.intent!==row.intent||actual.status!==(row.status??'RESOLVED'))report.intentOrStatusFailures++;
 if((badOperator||badAmount)&&report.failures.length<20)report.failures.push({text:row.text,expected,actual:price??null,status:actual.status,intent:actual.intent});
}
const output=process.argv[2];
if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(report.operatorFailures||report.amountOrCurrencyFailures)process.exitCode=1;
