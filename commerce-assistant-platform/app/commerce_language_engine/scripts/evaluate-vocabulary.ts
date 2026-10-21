/** Development alias targets; intentionally separate from frozen baseline observations. */
import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
const {values}=parseArgs({options:{base:{type:'string'},candidate:{type:'string'},review:{type:'string'},output:{type:'string'}}});
if(!values.base||!values.candidate||!values.review||!values.output)throw new Error('--base, --candidate, --review and --output are required');
const inputs=await Promise.all([values.base,values.candidate,values.review].map(p=>readFile(p,'utf8')));
const runtimes=inputs.slice(0,2).map(s=>compile(JSON.parse(s)));
const review=JSON.parse(inputs[2]) as {provenance:string;groups:{intent:string;verb:string;terms:string[]}[];held:unknown[]};
const rows=[];
for(const group of review.groups)for(const term of group.terms)for(const message of [`${group.verb} ${term}`,`please could you ${group.verb} ${term}?`,`would you ${group.verb} ${term} please`]){
 const outcomes=runtimes.map(runtime=>{const r=resolve(runtime,message);return {status:r.status,intent:r.intent,entities:r.entities,passed:r.status==='RESOLVED'&&r.intent===group.intent};});
 rows.push({message,expectedIntent:group.intent,before:outcomes[0],after:outcomes[1]});
}
const summary={count:rows.length,beforePassed:rows.filter(r=>r.before.passed).length,afterPassed:rows.filter(r=>r.after.passed).length,improved:rows.filter(r=>!r.before.passed&&r.after.passed).length,regressed:rows.filter(r=>r.before.passed&&!r.after.passed).length};
await writeFile(values.output,JSON.stringify({provenance:review.provenance,inputSha256:inputs.map(s=>createHash('sha256').update(s).digest('hex')),summary,held:review.held,cases:rows},null,2)+'\n');
console.log(JSON.stringify(summary));
if(!rows.length||summary.afterPassed!==rows.length||summary.regressed)process.exitCode=1;
