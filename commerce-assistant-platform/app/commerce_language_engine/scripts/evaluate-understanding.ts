import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import type {Context} from '../src/types.ts';

const args=process.argv.slice(2);
const splitIndex=args.indexOf('--split');
const split=splitIndex>=0?args[splitIndex+1]:'development';
if(!['development','holdout','all'].includes(split))throw new Error('Use --split development, holdout or all');
const root=new URL('../tests/fixtures/understanding-v1/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
const runtime=await loadRuntime();
const rows:{id:string;family:string;split:string;passed:boolean;errors:string[];status:string;intent:string|null;confidence:number;entities:Record<string,unknown>}[]=[];
for(const name of split==='all'?['development','holdout']:[split]){
 const content=await readFile(new URL(name+'.jsonl',root),'utf8');
 if(createHash('sha256').update(content).digest('hex')!==manifest.sha256[name+'.jsonl'])throw new Error('Frozen corpus checksum mismatch');
 for(const line of content.trim().split('\n')){
  const test=JSON.parse(line);let context:Context={};const turns=[];
  for(const text of test.messages){const result=resolve(runtime,text,context);context=result.context.next;turns.push(result);}
  const result=turns.at(-1)!;const expected=test.expected;const errors:string[]=[];
  for(const key of ['status','intent'] as const)if(expected[key]!==undefined&&result[key]!==expected[key])errors.push(key);
  for(const [path,value] of Object.entries(expected.entities??{})){
   const actual=path.split('.').reduce((v,k)=>v?.[k],result.entities);
   if(actual!==value)errors.push('entities.'+path);
  }
  if(expected.constraintKind&&!result.entities.requestConstraints?.some((c:{kind:string})=>c.kind===expected.constraintKind))errors.push('constraintKind');
  if(expected.noConstraints&&result.entities.requestConstraints?.length)errors.push('unexpectedConstraints');
  if(expected.maxItems!==undefined&&(result.entities.items?.length??1)>expected.maxItems)errors.push('itemBinding');
  if(expected.retainsSearch&&!result.context.next.activeSearch)errors.push('searchContext');
  rows.push({id:test.id,family:test.family,split:test.split,passed:!errors.length,errors,status:result.status,intent:result.intent,confidence:result.confidence,entities:result.entities});
 }
}
const summary={count:rows.length,passed:rows.filter(r=>r.passed).length,failed:rows.filter(r=>!r.passed).length,incorrectResolved:rows.filter(r=>!r.passed&&r.status==='RESOLVED').length};
const byFamily=Object.fromEntries([...new Set(rows.map(r=>r.family))].map(family=>{const group=rows.filter(r=>r.family===family);return [family,{count:group.length,passed:group.filter(r=>r.passed).length}];}));
const report={schemaVersion:1,dictionaryVersion:runtime.dictionary.version,generationFingerprint:runtime.dictionary.generationFingerprint,corpus:manifest,split,summary,byFamily,cases:rows};
const outIndex=args.indexOf('--output');
if(outIndex>=0)await writeFile(args[outIndex+1],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({summary,byFamily,failures:rows.filter(r=>!r.passed).map(({id,errors})=>({id,errors}))},null,2));
if(summary.failed)process.exitCode=1;
