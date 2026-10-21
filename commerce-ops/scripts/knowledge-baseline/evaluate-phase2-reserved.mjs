// Once-only evaluation against the immutable pre-implementation expectation lock.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {sha256} from './lib.mjs';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url))),out=join(root,'output/enterprise-knowledge-phase2-20261010');
const reportPath=join(out,'reserved-validation.json');if(existsSync(reportPath))throw new Error('Reserved results already exist; do not retune against them');
const bytes=readFileSync(join(out,'validation-reserved.json')),lock=JSON.parse(readFileSync(join(out,'validation-lock.json')));
if(sha256(bytes)!==lock.sha256)throw new Error('Validation expectations changed');
const validation=JSON.parse(bytes),snapshot=JSON.parse(readFileSync(join(out,'snapshot-manifest.json')));
const contains=(a,b)=>b&&typeof b==='object'?Array.isArray(b)?JSON.stringify(a)===JSON.stringify(b):Object.entries(b).every(([key,value])=>contains(a?.[key],value)):a===b;
async function evaluate(folder){
 const engine=join(root,folder,'engine');const {loadRuntime}=await import(pathToFileURL(join(engine,'src/runtime.ts')));const {resolve:interpret}=await import(pathToFileURL(join(engine,'src/engine.ts')));const compiled=await loadRuntime();
 return validation.cases.map(item=>{
  let context={},last;const turns=[];
  for(const text of item.turns){last=interpret(compiled,text,context);context=last.context?.next??context;turns.push({text,status:last.status,intent:last.intent,entities:last.entities,actions:last.actions});}
  const e=item.expected,checks={};
  for(const field of ['status','intent'])if(field in e)checks[field]=last[field]===e[field];
  for(const field of ['productText','price'])if(field in e)checks[field]=contains(last.entities[field],e[field]);
  if(e.relations)checks.relations=e.relations.every(want=>(last.entities.shoppingContext?.relations??[]).some(row=>contains(row,want)));
  if(e.absentRelations)checks.absentRelations=e.absentRelations.every(want=>!(last.entities.shoppingContext?.relations??[]).some(row=>contains(row,want)));
  if(e.evidenceKind)checks.evidenceKind=(last.entities.evidenceRequirements??[]).some(row=>row.kind===e.evidenceKind);
  if(e.needsClarification)checks.needsClarification=last.status==='NEEDS_CONTEXT';
  if(e.noWrite)checks.noWrite=!(last.actions??[]).length&&!(last.operations??[]).length;
  return {id:item.id,passed:Object.values(checks).every(Boolean),checks,turns};
 });
}
const baseline=await evaluate('output/enterprise-knowledge-phase1-20261010'),candidate=await evaluate('output/enterprise-knowledge-phase2-20261010');
const improvements=candidate.filter((r,i)=>r.passed&&!baseline[i].passed).map(r=>r.id),regressions=candidate.filter((r,i)=>!r.passed&&baseline[i].passed).map(r=>r.id);
const report={createdAt:new Date().toISOString(),scope:validation.scope,expectedSha256:lock.sha256,fingerprint:snapshot.artifact.fingerprint,counts:{conversations:candidate.length,turns:validation.cases.reduce((n,c)=>n+c.turns.length,0),baselinePassed:baseline.filter(r=>r.passed).length,candidatePassed:candidate.filter(r=>r.passed).length,improvements:improvements.length,regressions:regressions.length},improvements,regressions,baseline,candidate};
writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({counts:report.counts,failures:candidate.filter(r=>!r.passed).map(r=>({id:r.id,checks:r.checks}))}));
