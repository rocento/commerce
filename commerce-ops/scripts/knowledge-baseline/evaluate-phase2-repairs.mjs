// Original expectations become regression; fresh expectations run once after freeze.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {sha256} from './lib.mjs';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url))),out=join(root,'output/enterprise-knowledge-phase2-fixes-20261010'),prior=join(root,'output/enterprise-knowledge-phase2-20261010');
const read=path=>JSON.parse(readFileSync(path));
for(const file of ['reserved-validation.json','original-regression.json'])if(existsSync(join(out,file)))throw new Error('Frozen repair evaluation already exists');
const contains=(a,b)=>b&&typeof b==='object'?Object.entries(b).every(([key,value])=>contains(a?.[key],value)):a===b;
async function load(folder){const engine=join(folder,'engine');const {loadRuntime}=await import(pathToFileURL(join(engine,'src/runtime.ts')));const {resolve:interpret}=await import(pathToFileURL(join(engine,'src/engine.ts')));return {compiled:await loadRuntime(),interpret};}
const before=await load(prior),after=await load(out);
function evaluate(runtime,validation){return validation.cases.map(item=>{
 let context={},last;const turns=[];
 for(const text of item.turns){last=runtime.interpret(runtime.compiled,text,context);context=last.context?.next??context;turns.push({text,status:last.status,intent:last.intent,entities:last.entities,message:last.message,actions:last.actions,operations:last.operations});}
 const e=item.expected,checks={};
 for(const field of ['status','intent'])if(field in e)checks[field]=last[field]===e[field];
 for(const field of ['productText','price'])if(field in e)checks[field]=contains(last.entities[field],e[field]);
 if(e.relations)checks.relations=e.relations.every(want=>(last.entities.shoppingContext?.relations??[]).some(row=>contains(row,want)));
 if(e.absentRelations)checks.absentRelations=e.absentRelations.every(want=>!(last.entities.shoppingContext?.relations??[]).some(row=>contains(row,want)));
 if(e.evidenceKind)checks.evidenceKind=(last.entities.evidenceRequirements??[]).some(row=>row.kind===e.evidenceKind);
 if(e.needsClarification)checks.needsClarification=last.status==='NEEDS_CONTEXT';
 if(e.noWrite)checks.noWrite=!(last.actions??[]).length&&!(last.operations??[]).length;
 if(e.questionContains)checks.question=String(last.message).toLowerCase().includes(e.questionContains.toLowerCase());
 return {id:item.id,passed:Object.values(checks).every(Boolean),checks,turns};
});}
for(const [folder,name,scope] of [[prior,'original-regression.json','Original 28 expectations, now used for regression after observing their failures; not fresh validation.'],[out,'reserved-validation.json','Fresh wording locked before the repairs; AI-authored and related grammar families, not independent human or family-disjoint validation.']]){
 const bytes=readFileSync(join(folder,'validation-reserved.json')),lock=read(join(folder,'validation-lock.json'));if(sha256(bytes)!==lock.sha256)throw new Error('Changed expectations');
 const validation=JSON.parse(bytes),baseline=evaluate(before,validation),candidate=evaluate(after,validation);
 const improvements=candidate.filter((r,i)=>r.passed&&!baseline[i].passed).map(r=>r.id),regressions=candidate.filter((r,i)=>!r.passed&&baseline[i].passed).map(r=>r.id);
 const counts={conversations:candidate.length,turns:validation.cases.reduce((n,c)=>n+c.turns.length,0),baselinePassed:baseline.filter(r=>r.passed).length,candidatePassed:candidate.filter(r=>r.passed).length,improvements:improvements.length,regressions:regressions.length};
 const report={createdAt:new Date().toISOString(),scope,expectedSha256:lock.sha256,baselineFingerprint:before.compiled.dictionary.generationFingerprint,fingerprint:after.compiled.dictionary.generationFingerprint,counts,improvements,regressions,baseline,candidate};
 writeFileSync(join(out,name),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({name,counts,failures:candidate.filter(r=>!r.passed).map(r=>({id:r.id,checks:r.checks}))}));
}
