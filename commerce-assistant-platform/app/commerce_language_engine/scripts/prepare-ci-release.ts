/** Explicit disposable CI installation only. Never called by service startup. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import pg from 'pg';
import {migrate,closeDb,withDb} from '../src/database.ts';
import {stageRelease,loadRelease,recordReleaseEvaluation,bootstrapRelease,dictionaryContentFingerprint} from '../src/release-lifecycle.ts';
import {runtimeSha256} from '../src/runtime-identity.ts';
import {evaluateReleaseCandidate} from './release-evaluation.ts';
import {RELEASE_CONTRACT_VERSION} from './deployment-release.ts';
import {exportDatabaseRelease} from './export-db-release.ts';
import type {Dictionary,CorpusCase} from '../src/types.ts';

export function assertCiTarget(environment:NodeJS.ProcessEnv){
 assert.ok(environment.CI==='true'&&environment.CLE_CI_BOOTSTRAP==='true','CI=true and CLE_CI_BOOTSTRAP=true are required for the disposable CI preparer.');
 assert.ok(environment.DATABASE_URL,'Explicit DATABASE_URL is required.');
 const target=new URL(environment.DATABASE_URL);
 assert.ok(['postgres:','postgresql:'].includes(target.protocol)&&['localhost','127.0.0.1','[::1]'].includes(target.hostname),'CI preparation requires loopback PostgreSQL.');
 assert.match(decodeURIComponent(target.pathname.slice(1)),/^(commerce_language|language_ci_[a-f0-9]{32})$/,'CI preparer only accepts its explicit disposable language database names.');
 return target;
}
export async function prepareCiRelease(options:{artifact:string;outputDir:string}){
 const target=assertCiTarget(process.env);
 assert.ok(options.outputDir,'An explicit output directory is required.');
 const dictionary=JSON.parse(await readFile(options.artifact,'utf8')) as Dictionary;
 const corpus=JSON.parse(await readFile(new URL('../tests/fixtures/ci-release-smoke.json',import.meta.url),'utf8')) as CorpusCase[];
 const runtimeHash=await runtimeSha256();
 const reviewed={...dictionary,generationFingerprint:dictionaryContentFingerprint(dictionary)};
 const preflight=evaluateReleaseCandidate(reviewed,corpus,{releaseId:null,runtimeSha256:runtimeHash});
 assert.ok(preflight.passed,'The CI smoke fixture failed; no database changes have been made.');
 const guard=new pg.Client({connectionString:target.href});await guard.connect();
 try{
  await guard.query('SELECT pg_advisory_lock(57442)');
  const existing=await guard.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') LIMIT 1");
  assert.equal(existing.rowCount,0,'CI preparation requires an empty database; existing installations are never changed.');
  await migrate();
  const candidate=await withDb(c=>stageRelease(c,{dictionary:reviewed,corpus,baseReleaseId:null,source:'ci-disposable-installation',manifest:{qualityScope:'four-case CI installation smoke only; not a production release evaluation'}}));
  const frozen=await withDb(c=>loadRelease(c,candidate.releaseId));
  const report=evaluateReleaseCandidate(frozen.dictionary,frozen.dictionary.corpus,{releaseId:candidate.releaseId,runtimeSha256:runtimeHash});
  assert.ok(report.passed,'The frozen CI candidate failed its smoke fixture.');
  assert.equal(await runtimeSha256(),runtimeHash,'Runtime changed during CI preparation.');
  const evaluationId=await withDb(c=>recordReleaseEvaluation(c,{releaseId:candidate.releaseId,artifactSha256:candidate.artifactSha256,corpusSha256:candidate.corpusSha256,runtimeSha256:runtimeHash,rubricVersion:report.rubricVersion,contractVersion:String(RELEASE_CONTRACT_VERSION),passed:report.passed,report:{...report,qualityScope:'CI installation smoke only'}}));
  await withDb(c=>bootstrapRelease(c,{releaseId:candidate.releaseId,actor:'github-ci',reason:'Explicit empty CI installation with a four-case smoke fixture'}));
  const exported=await exportDatabaseRelease(frozen,pathToFileURL(resolve(options.outputDir)+'/'));
  return {...exported,evaluationId,runtimeSha256:runtimeHash,qualityScope:'CI installation smoke only; not release-quality evidence'};
 }finally{await guard.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{artifact:{type:'string'},'output-dir':{type:'string'}}});
 if(!values.artifact||!values['output-dir'])throw new Error('Usage: prepare-ci-release.ts --artifact <compiled.json> --output-dir <CI build data directory>');
 try{console.log(JSON.stringify(await prepareCiRelease({artifact:values.artifact,outputDir:values['output-dir']}),null,2));}finally{await closeDb();}
}
