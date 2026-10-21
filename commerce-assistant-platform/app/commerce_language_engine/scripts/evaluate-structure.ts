import {writeFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {structureCases} from '../src/generation/structure-cases.ts';
import {loadRuntime} from '../src/runtime.ts';
import {buildExpandedDictionary} from '../src/generation/dictionary.ts';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const compiled=process.argv.includes('--source')?compile(buildExpandedDictionary()):await loadRuntime();
let total=0,passed=0;const failures:unknown[]=[];
for(const c of structureCases()){
 const r=resolve(compiled,c.text);total++;
 const errors=Object.entries(c.entities??{}).filter(([key,value])=>!isDeepStrictEqual(r.entities[key],value)).map(([key])=>key);
 if(r.intent===c.intent&&r.status===c.status&&!errors.length)passed++;
 else if(failures.length<30)failures.push({text:c.text,expected:c.intent,actual:r.intent,status:r.status,entityErrors:errors});
}
const report={dictionaryVersion:compiled.dictionary.version,total,passed,failed:total-passed,warning:'Authored compositional regression cases; not real customer data or an independent holdout.',failures};
await writeFile('data/structure-evaluation.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(passed!==total)process.exitCode=1;
