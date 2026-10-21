/** Local corpus compatibility and held-out routing checks; no model or index calls. */
import {readFile, writeFile} from 'node:fs/promises';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';

const runtime=await loadRuntime();
type Example={id:string;utterance:string;canonical_text:string;intent:string;review:{slots:Record<string,unknown>}};
type Holdout={id:string;text:string;intent:string|null;slots:Record<string,unknown>;status?:string};
const examples:Example[]=JSON.parse(await readFile(new URL('../../../knowledge/intent-examples.discovery-v2.en.json',import.meta.url),'utf8'));
const holdout:Holdout[]=JSON.parse(await readFile(new URL('../../../evals/intent-discovery-holdout.en.json',import.meta.url),'utf8'));
const check=(id:string,text:string,intent:string|null,slots:Record<string,unknown>,status='RESOLVED')=>{
 const result=resolve(runtime,text);
 const mismatches=Object.entries(slots).filter(([key,value])=>JSON.stringify(result.entities[key])!==JSON.stringify(value)).map(([key])=>key);
 return {id,text,expected_intent:intent,status:result.status,intent:result.intent,
  passed:result.status===status&&result.intent===intent&&mismatches.length===0,
  mismatched_slots:mismatches};
};
const corpus=examples.map(e=>check(e.id,e.canonical_text,e.intent,e.review.slots));
const cases=holdout.map(e=>check(e.id,e.text,e.intent,e.slots,e.status));
const leakage=holdout.filter(h=>examples.some(e=>e.utterance.trim().toLowerCase()===h.text.trim().toLowerCase())).map(h=>h.id);
const report={scope:'Offline canonical compatibility and held-out language routing; retrieval/model accuracy not measured',
 status:[...corpus,...cases].every(r=>r.passed)&&leakage.length===0?'passed':'failed',
 canonical_examples:{total:corpus.length,passed:corpus.filter(r=>r.passed).length,results:corpus},
 held_out:{total:cases.length,passed:cases.filter(r=>r.passed).length,results:cases},split_leakage:leakage};
const serialized=JSON.stringify(report,null,2)+'\n';
if(process.argv[2])await writeFile(process.argv[2],serialized);
console.log(serialized);
if(report.status!=='passed')process.exitCode=1;
