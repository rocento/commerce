// Recheck previously authored examples against the frozen release-preparation runtime.
// These are development regressions, never independent held-out or live scores.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'../..'),out=resolve(process.argv[2]??join(root,'output/enterprise-knowledge-release-prep-20261010'));
const previous=JSON.parse(readFileSync(join(root,'output/enterprise-knowledge-expansion-20261010/authored-examples.json')));
const [{loadRuntime},{resolve:interpret},{runtimeSha256}]=await Promise.all(['runtime.ts','engine.ts','runtime-identity.ts'].map(name=>import(pathToFileURL(join(out,'engine/src',name)))));
const runtime=await loadRuntime();
const cases=previous.candidate.map(test=>{
 const result=interpret(runtime,test.text);
 const passed=result.status==='RESOLVED'&&['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(result.intent)&&(result.entities.shoppingContext?.relations??[]).some(r=>r.relation===test.expected.relation&&r.value===test.expected.value);
 return {id:test.id,text:test.text,expected:test.expected,passed,status:result.status,intent:result.intent,entities:result.entities,previousPassed:test.passed};
});
const report={scope:'Previously exposed AI-authored development examples, unchanged expectations',createdAt:new Date().toISOString(),runtimeSha256:await runtimeSha256(pathToFileURL(join(out,'engine/'))),fingerprint:runtime.dictionary.generationFingerprint,counts:{cases:cases.length,passed:cases.filter(c=>c.passed).length,improved:cases.filter(c=>c.passed&&!c.previousPassed).length,regressed:cases.filter(c=>!c.passed&&c.previousPassed).length},cases};
writeFileSync(join(out,'authored-examples.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report.counts));assert.ok(cases.every(c=>c.passed),'Authored typed-context regression failed');
