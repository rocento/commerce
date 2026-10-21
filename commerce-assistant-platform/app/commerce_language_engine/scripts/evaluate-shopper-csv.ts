import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve as absolute,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {parseCsv,selectCases,evaluateTurn,rubricVersion,sha256,type EvaluationResult,type ShopperCase} from './shopper-csv-evaluation.ts';

const args=process.argv.slice(2);
const option=(name:string,fallback?:string)=>{const index=args.indexOf(name);if(index<0)return fallback;if(!args[index+1]||args[index+1].startsWith('--'))throw new Error(`Missing value for ${name}`);return args[index+1];};
const repository=fileURLToPath(new URL('../../../../',import.meta.url));
const sourceRoot=join(repository,'output/live-shopper-eval-20261008');
const csvPath=absolute(option('--csv',join(sourceRoot,'live-shopping-assistant-4000-english.csv'))!);
const casesPath=absolute(option('--cases',join(sourceRoot,'cases.json'))!);
const engineRoot=absolute(option('--engine-root',fileURLToPath(new URL('../',import.meta.url)))!);
const outputPath=absolute(option('--output',join(repository,'output/language-engine-csv-20261009/current.json'))!);
const [csvContent,casesContent]=await Promise.all([readFile(csvPath),readFile(casesPath)]);
const csvRows=parseCsv(csvContent.toString('utf8'));
const selected=selectCases(csvRows,JSON.parse(casesContent.toString('utf8')) as ShopperCase[]);
const [{loadRuntime},{resolve}]=await Promise.all([import(pathToFileURL(join(engineRoot,'src/runtime.ts')).href),import(pathToFileURL(join(engineRoot,'src/engine.ts')).href)]);
async function sourceDigest(){
 const paths:string[]=[];
 async function walk(path:string){for(const entry of await readdir(path,{withFileTypes:true})){const child=join(path,entry.name);if(entry.isDirectory())await walk(child);else if(entry.name.endsWith('.ts'))paths.push(child);}}
 await walk(join(engineRoot,'src'));const hash=createHash('sha256');
 for(const path of paths.sort()){hash.update(path.slice(engineRoot.length));hash.update('\0');hash.update(await readFile(path));hash.update('\0');}
 return hash.digest('hex');
}
const initialSourceDigest=await sourceDigest();
const initialCompiledDigest=sha256(await readFile(join(engineRoot,'data/compiled.json')));
const compiled=await loadRuntime();
const rows:any[]=[];
const started=Date.now();
for(const item of selected){
 let context:Record<string,unknown>={industry:item.store};let previous:EvaluationResult|undefined;
 for(const [index,text] of item.turns.entries()){
  const result:EvaluationResult=resolve(compiled,text,context);
  const checks=evaluateTurn(item,index,result,previous);
  rows.push({caseId:item.case_id,family:item.family_id,scenario:item.scenario_family,store:item.store,turn:index+1,text,passed:checks.every(check=>check.passed),status:result.status,intent:result.intent,checkCount:checks.length,failures:checks.filter(check=>!check.passed),entities:result.entities,checks:checks.map(({code,passed})=>({code,passed}))});
  context=result.context?.next??context;previous=result;
 }
}
function count(values:string[]){return Object.fromEntries([...new Set(values)].sort().map(value=>[value,values.filter(item=>item===value).length]));}
function summarize(group:typeof rows){return {turns:group.length,passed:group.filter(row=>row.passed).length,failed:group.filter(row=>!row.passed).length,status:count(group.map(row=>row.status)),intent:count(group.map(row=>row.intent??'null'))};}
const byFamily=Object.fromEntries([...new Set(rows.map(row=>row.family))].sort().map(family=>[family,summarize(rows.filter(row=>row.family===family))]));
const byStore=Object.fromEntries([...new Set(rows.map(row=>row.store))].sort().map(store=>[store,summarize(rows.filter(row=>row.store===store))]));
const checkCodes=[...new Set(rows.flatMap(row=>row.checks.map((check:any)=>check.code)))].sort();
const checks=Object.fromEntries(checkCodes.map(code=>{const matching=rows.flatMap(row=>row.checks).filter(check=>check.code===code);return [code,{count:matching.length,passed:matching.filter(check=>check.passed).length,failed:matching.filter(check=>!check.passed).length}];}));
const fullyPassingCases=selected.filter(item=>rows.filter(row=>row.caseId===item.case_id).every(row=>row.passed)).length;
let comparison:Record<string,unknown>|undefined;
const baselinePath=option('--baseline');
if(baselinePath){
 const baseline=JSON.parse(await readFile(baselinePath,'utf8'));
 if(baseline.provenance.csvSha256!==sha256(csvContent)||baseline.provenance.rubricVersion!==rubricVersion||baseline.provenance.rubricSha256!==sha256(await readFile(new URL('shopper-csv-evaluation.ts',import.meta.url))))throw new Error('Baseline uses a different CSV or rubric; rerun it with the frozen engine snapshot.');
 const before=new Map<string,any>(baseline.rows.map((row:any)=>[`${row.caseId}:${row.turn}`,row]));
 const improved=rows.filter(row=>row.passed&&!before.get(`${row.caseId}:${row.turn}`)?.passed);
 const regressed=rows.filter(row=>!row.passed&&before.get(`${row.caseId}:${row.turn}`)?.passed);
 const changedChecks=rows.flatMap(row=>{const prior=before.get(`${row.caseId}:${row.turn}`);return row.checks.filter((check:any)=>prior?.checks.some((old:any)=>old.code===check.code&&old.passed!==check.passed)).map((check:any)=>({caseId:row.caseId,turn:row.turn,...check}));});
 comparison={baseline:baselinePath,previousPassedTurns:baseline.summary.passed,improvedTurns:improved.length,regressedTurns:regressed.length,improvedChecks:changedChecks.filter(check=>check.passed).length,regressedChecks:changedChecks.filter(check=>!check.passed).length,regressions:regressed.map(({caseId,turn,failures})=>({caseId,turn,failures})),checkRegressions:changedChecks.filter(check=>!check.passed)};
}
if(await sourceDigest()!==initialSourceDigest||sha256(await readFile(join(engineRoot,'data/compiled.json')))!==initialCompiledDigest)throw new Error('Engine source or compiled artifact changed during evaluation. Rerun after edits finish, or use --engine-root with an immutable snapshot.');
const report={schemaVersion:1,generatedAt:new Date().toISOString(),provenance:{csvPath,csvSha256:sha256(csvContent),casesPath,casesSha256:sha256(casesContent),rubricVersion,rubricSha256:sha256(await readFile(new URL('shopper-csv-evaluation.ts',import.meta.url))),engineRoot,engineSourceSha256:initialSourceDigest,compiledSha256:initialCompiledDigest,generationFingerprint:compiled.dictionary.generationFingerprint,languagePackRevision:compiled.dictionary.languageKnowledge?.revision,dictionaryVersion:compiled.dictionary.version},methodology:{scope:'Offline language parsing only; no HTTP, catalog lookup, recommendation quality, factual grounding, action execution, or production readiness claim.',context:'Each CSV conversation is replayed in order using only the previous engine result.context.next. Industry is supplied; no fabricated assistant answers or product results are injected.',labels:'Family routing from original generator tasks; entity/relationship expectations from source prompt and metadata. Response_good ratings and assistant responses are never used as labels.',passing:'Every applicable minimum semantic check passes. Family route accepts a correctly targeted clarification; UNKNOWN never passes a route check. RESOLVED alone does not imply success.',corpusRole:'Existing synthetic development corpus. Repeated templates and profiles are not independent held-out shopper conversations. Improvements are coverage, not a generalization score.',limitations:['Long-form advisory families may require capabilities beyond this deterministic parser.','Passing does not certify safety or suitability advice, budget totals, real product matching, factual correctness, or all goals in multi-intent requests.','Discourse evaluation recognizes explicit roles/intents and honest context requests; it cannot assess the eventual conversational answer.']},summary:{conversations:selected.length,fullyPassingConversations:fullyPassingCases,...summarize(rows),elapsedMs:Date.now()-started},byStore,byFamily,checks,comparison,rows};
await mkdir(dirname(outputPath),{recursive:true});await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output:outputPath,summary:report.summary,checks,comparison,representativeFailures:Object.fromEntries(checkCodes.map(code=>[code,rows.filter(row=>row.failures.some((check:any)=>check.code===code)).slice(0,2).map(({caseId,turn,text,status,intent,failures})=>({caseId,turn,text,status,intent,failures:failures.filter((check:any)=>check.code===code)}))]))},null,2));
