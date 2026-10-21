import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {stageRelease,importBaselineRelease,createReleaseDraft,reviseReleaseDraft,freezeReleaseDraft,loadRelease,currentReleaseId,recordReleaseEvaluation,promoteRelease,bootstrapRelease,rollbackRelease} from '../src/release-lifecycle.ts';
import {withDb,closeDb} from '../src/database.ts';
import {runtimeSha256} from '../src/runtime-identity.ts';
import {decodeReleaseBundle,RELEASE_CONTRACT_VERSION,uuidPattern} from './deployment-release.ts';
import {evaluateReleaseCandidate,RELEASE_RUBRIC_VERSION} from './release-evaluation.ts';
import {loadDataset,evaluateReviewedDataset} from '../src/reviewed-evaluation.ts';
import type {Dictionary,CorpusCase} from '../src/types.ts';

export function releaseArguments(args:string[]){
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{'dataset-id':{type:'string'},'release-id':{type:'string'},'draft-id':{type:'string'},revision:{type:'string'},'change-key':{type:'string'},'evaluation-id':{type:'string'},'expected-active':{type:'string'},actor:{type:'string'},reason:{type:'string'},artifact:{type:'string'},corpus:{type:'string'},bundle:{type:'string'},report:{type:'string'}}});
 const command=positionals[0];
 if(positionals.length!==1||!['stage','draft-new','draft-revise','draft-freeze','import','import-baseline','evaluate','promote','bootstrap','rollback','inspect'].includes(command))throw new Error('Usage: release.ts <stage|draft-new|draft-revise|draft-freeze|import|import-baseline|evaluate|promote|bootstrap|rollback|inspect> [options]');
 const uuid=(key:'release-id'|'evaluation-id'|'draft-id')=>{if(!values[key]||!uuidPattern.test(values[key]))throw new Error('--'+key+' <uuid> is required');};
 if(['evaluate','promote','bootstrap','rollback','inspect'].includes(command))uuid('release-id');
 if(command==='promote')uuid('evaluation-id');
 if(['draft-revise','draft-freeze'].includes(command)){uuid('draft-id');if(!/^[1-9][0-9]*$/.test(values.revision??'')||!Number.isSafeInteger(Number(values.revision)))throw new Error('--revision <positive-integer> is required');}
 if(command==='draft-revise'&&!values['change-key']?.trim())throw new Error('--change-key is required');
 if(['promote','bootstrap','rollback'].includes(command))for(const key of ['actor','reason'] as const)if(!values[key]?.trim())throw new Error('--'+key+' is required');
 if(['stage','draft-new','import','import-baseline','promote','rollback'].includes(command)){
  if(!values['expected-active']||!(uuidPattern.test(values['expected-active'])||(values['expected-active']==='none'&&command!=='rollback')))throw new Error('--expected-active <current-release-uuid|none> is required');
 }
 if(['stage','draft-new','draft-revise'].includes(command)&&(!values.artifact||!values.corpus))throw new Error('stage requires --artifact <dictionary.json> and --corpus <cases.jsonl>');
 if(['import','import-baseline'].includes(command)&&!values.bundle)throw new Error('import requires --bundle <deployment-release.json.gz>');
 return {command,values,expectedActiveReleaseId:values['expected-active']==='none'?null:values['expected-active']};
}
export async function runReleaseCommand(args:string[]){
 const {command,values,expectedActiveReleaseId}=releaseArguments(args);
 if(!process.env.DATABASE_URL)throw new Error('Explicit DATABASE_URL is required for release operations.');
 const runtimeHash=await runtimeSha256();
 if(command==='draft-freeze')return withDb(c=>freezeReleaseDraft(c,{draftId:values['draft-id']!,revision:Number(values.revision)}));
 if(['stage','draft-new','draft-revise'].includes(command)){
  const dictionary=JSON.parse(await readFile(values.artifact!,'utf8')) as Dictionary;
  const corpus=(await readFile(values.corpus!,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)) as CorpusCase[];
  if(command==='draft-revise')return withDb(c=>reviseReleaseDraft(c,{draftId:values['draft-id']!,expectedRevision:Number(values.revision),dictionary,corpus,change:{kind:'reviewed-snapshot',key:values['change-key']!,payload:{}}}));
  return withDb(async c=>{
   if(await currentReleaseId(c)!==expectedActiveReleaseId)throw new Error('Active release differs from --expected-active; inspect the baseline before staging.');
   const stage=command==='draft-new'?createReleaseDraft:stageRelease;
   return {activated:false,...await stage(c,{dictionary,corpus,baseReleaseId:expectedActiveReleaseId!,source:'explicit-artifact-draft'})};
  });
 }
 if(command==='import'||command==='import-baseline'){
  const {payload,checksum}=decodeReleaseBundle(await readFile(values.bundle!));
  if(payload.format!==2)throw new Error('Legacy bundles have no stable release identity. Stage their artifact explicitly before export.');
  if(payload.identity.runtimeSha256!==runtimeHash)throw new Error('Bundle runtime differs from this checkout; import using its matching runtime.');
  if(command==='import'&&payload.identity.baseReleaseId!==expectedActiveReleaseId)throw new Error('Bundle base differs from --expected-active; create and reevaluate a rebased candidate.');
  return withDb(async c=>{
   if(await currentReleaseId(c)!==expectedActiveReleaseId)throw new Error('Active release differs from --expected-active.');
   if(command==='import-baseline')return {activated:false,...await importBaselineRelease(c,{...payload.identity,dictionary:payload.artifact,corpus:payload.corpus,corpusArchive:Buffer.from(payload.corpusArchive,'base64'),manifest:{...payload.manifest,bundleChecksum:checksum}})};
   const result=await stageRelease(c,{dictionary:{...payload.artifact,corpus:[]},corpus:payload.corpus,corpusArchive:Buffer.from(payload.corpusArchive,'base64'),baseReleaseId:payload.identity.baseReleaseId,source:'release-bundle-import',releaseId:payload.identity.releaseId,manifest:{...payload.manifest,bundleChecksum:checksum,identity:payload.identity}});
   if(result.artifactSha256!==payload.identity.artifactSha256||result.corpusSha256!==payload.identity.corpusSha256)throw new Error('Imported release content identity differs from bundle.');
   return {activated:false,...result};
  });
 }
 if(command==='evaluate'){
  const candidate=await withDb(c=>loadRelease(c,values['release-id']!));
  const reviewed=values['dataset-id']?evaluateReviewedDataset(candidate.dictionary,await withDb(c=>loadDataset(c,values['dataset-id']!)),{releaseId:candidate.releaseId,runtimeSha256:runtimeHash}):undefined;
  const report={...evaluateReleaseCandidate(candidate.dictionary,candidate.dictionary.corpus,{releaseId:candidate.releaseId,runtimeSha256:runtimeHash}),releaseId:candidate.releaseId,artifactSha256:candidate.artifactSha256,corpusSha256:candidate.corpusSha256,runtimeSha256:runtimeHash,contractVersion:RELEASE_CONTRACT_VERSION,createdAt:new Date().toISOString()};
  if(reviewed){report.passed=report.passed&&reviewed.passed;Object.assign(report,{reviewedDataset:{datasetId:reviewed.datasetId,sha256:reviewed.datasetSha256,count:reviewed.count,failureCount:reviewed.failureCount,passed:reviewed.passed}});}
  if(await runtimeSha256()!==runtimeHash)throw new Error('Runtime source changed during evaluation; rerun from an immutable checkout or image.');
  const evaluationId=await withDb(c=>recordReleaseEvaluation(c,{...report,contractVersion:String(RELEASE_CONTRACT_VERSION),report,reviewed}));
  const result={evaluationId,...report};
  if(values.report)await writeFile(values.report,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  return result;
 }
 if(command==='inspect')return withDb(async c=>{const row=await loadRelease(c,values['release-id']!);return {releaseId:row.releaseId,baseReleaseId:row.base_release_id??null,fingerprint:row.fingerprint,artifactSha256:row.artifactSha256,corpusSha256:row.corpusSha256,corpusCases:row.dictionary.corpus.length,active:await currentReleaseId(c)===row.releaseId};});
 const shared={releaseId:values['release-id']!,actor:values.actor!,reason:values.reason!};
 if(command==='bootstrap')return withDb(c=>bootstrapRelease(c,shared));
 if(command==='rollback')return withDb(c=>rollbackRelease(c,{...shared,expectedActiveReleaseId:expectedActiveReleaseId!}));
 return withDb(c=>promoteRelease(c,{...shared,evaluationId:values['evaluation-id']!,expectedActiveReleaseId:expectedActiveReleaseId!,runtimeSha256:runtimeHash,rubricVersion:RELEASE_RUBRIC_VERSION,contractVersion:String(RELEASE_CONTRACT_VERSION)}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const report=await runReleaseCommand(process.argv.slice(2));console.log(JSON.stringify(report,null,2));if('passed' in report&&report.passed===false)process.exitCode=1;}finally{await closeDb();}
}
