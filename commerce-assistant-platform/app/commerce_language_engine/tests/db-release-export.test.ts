import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm,readdir,cp,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareDatabaseExport,exportDatabaseRelease,type DatabaseReleaseRow} from '../scripts/export-db-release.ts';
import {readDeploymentRelease} from '../scripts/deployment-release.ts';
import {projectKnowledge} from '../src/knowledge-store.ts';
import {knowledgeHash} from '../src/language-knowledge.ts';
import {compile} from '../src/compiler.ts';
import {resolve as resolveLanguage} from '../src/engine.ts';
const exec=promisify(execFile),root=new URL('../',import.meta.url);
const original=(recognitionFixture(JSON.parse(await readFile(new URL('data/compiled.json',root),'utf8'))));
const {languageKnowledge:_old,...base}=original;
const pack={schemaVersion:1,id:'export-test',revision:1,language:'en',source:'reviewed export fixture',concepts:[{id:'activity.classes',kind:'activity',canonical:'online classes',aliases:['remote lessons']}],rules:[{id:'for-activity',marker:'for',targetKind:'activity',relation:'intended_use',scope:'product',priority:80}]};
const dictionary=projectKnowledge(base,pack).dictionary;
const {corpus:_corpus,generationFingerprint:_oldFingerprint,...content}=dictionary;
const fingerprint=knowledgeHash(content),artifact={...content,corpus:[],generationFingerprint:fingerprint};
const corpus=[{text:'find a laptop for online classes',intent:'PRODUCT_SEARCH',difficulty:'easy',source:'reviewed export fixture'}];
const corpusText=corpus.map(c=>JSON.stringify(c)).join('\n')+'\n';
const row:DatabaseReleaseRow={id:randomUUID(),dictionary_version:artifact.version,fingerprint,artifact,corpus_gzip:gzipSync(Buffer.from(corpusText)),manifest:{source:'active-db-fixture',languageKnowledge:{packId:pack.id,revision:1},counts:{evaluationUtterances:999}}};

test('DB authoring export produces matching verified inputs and preserves contextual knowledge',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'knowledge-authoring-export-')),data=pathToFileURL(join(directory,'data')+'/');t.after(()=>rm(directory,{recursive:true,force:true}));
 const report=await exportDatabaseRelease(row,data,{syncAuthoring:true});
 assert.equal(report.authoringSynced,true);assert.equal(report.files.length,5);
 const generated=JSON.parse(await readFile(new URL('generated.json',data),'utf8')),manifest=JSON.parse(await readFile(new URL('generation-report.json',data),'utf8'));
 assert.deepEqual(generated,artifact);assert.equal(manifest.fingerprint,fingerprint);assert.equal(manifest.version,artifact.version);assert.equal(manifest.counts.evaluationUtterances,1);
 assert.equal(await readFile(new URL('corpus.jsonl',data),'utf8'),corpusText);
 const exported=await readDeploymentRelease(data);assert.equal(exported.release!.payload.manifest.fingerprint,fingerprint);assert.deepEqual(exported.release!.payload.corpus,corpus);
 const resolved=resolveLanguage(compile(exported.compiled),'find a laptop for remote lessons');
 assert.equal(resolved.entities.shoppingContext.relations[0].relation,'intended_use');assert.equal(resolved.entities.shoppingContext.relations[0].value,'online classes');
 assert.equal((await readdir(data)).some(name=>name.endsWith('.tmp')),false);
 // Run the actual verification and authoring-export scripts in an isolated workspace.
 await mkdir(join(directory,'scripts'));
 await cp(new URL('scripts/verify-artifacts.ts',root),join(directory,'scripts/verify-artifacts.ts'));
 await cp(new URL('scripts/export-release.ts',root),join(directory,'scripts/export-release.ts'));
 await cp(new URL('scripts/deployment-release.ts',root),join(directory,'scripts/deployment-release.ts'));
 await cp(new URL('package-lock.json',root),join(directory,'package-lock.json')); 
 await symlink(fileURLToPath(new URL('src/',root)),join(directory,'src'),'dir');
 await writeFile(join(directory,'package.json'),JSON.stringify({type:'module'}));
 const checked=await exec(process.execPath,['scripts/verify-artifacts.ts'],{cwd:directory});assert.equal(JSON.parse(checked.stdout).status,'pass');
 await exec(process.execPath,['scripts/export-release.ts'],{cwd:directory});
 const reexported=await readDeploymentRelease(data);assert.deepEqual(reexported.release!.payload,exported.release!.payload);
});

test('default DB export leaves authoring files unchanged',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'knowledge-runtime-export-')),data=pathToFileURL(directory+'/');t.after(()=>rm(directory,{recursive:true,force:true}));
 await writeFile(new URL('generated.json',data),'existing authoring input');
 const report=await exportDatabaseRelease(row,data);assert.equal(report.authoringSynced,false);assert.equal(report.files.length,2);
 assert.equal(await readFile(new URL('generated.json',data),'utf8'),'existing authoring input');assert.deepEqual((await readDeploymentRelease(data)).compiled,artifact);
});

test('invalid release data is rejected before any destination files change',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'knowledge-invalid-export-')),data=pathToFileURL(directory+'/');t.after(()=>rm(directory,{recursive:true,force:true}));
 await writeFile(new URL('compiled.json',data),'original bytes');
 await assert.rejects(exportDatabaseRelease({...row,fingerprint:'different'},data,{syncAuthoring:true}),/fingerprint/);
 assert.equal(await readFile(new URL('compiled.json',data),'utf8'),'original bytes');assert.deepEqual(await readdir(data),['compiled.json']);
 assert.throws(()=>prepareDatabaseExport({...row,corpus_gzip:gzipSync(Buffer.from('{"text":"incomplete"}\n'))},'a'.repeat(64)),/invalid cases/);
 assert.throws(()=>prepareDatabaseExport({...row,artifact:{...artifact,languageKnowledge:{...artifact.languageKnowledge!,rules:[]}}},'a'.repeat(64)),/bounds/);
});
