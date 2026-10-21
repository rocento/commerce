import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import {loadResolutionProvenance,resolutionEnvelope,validateResolutionEnvelope} from '../src/resolution-wire.ts';
import {runtimeSha256} from '../src/runtime-identity.ts';

const runtime=await loadRuntime();
const provenance=await loadResolutionProvenance(runtime.dictionary);

test('versioned wire projection preserves semantics and isolates diagnostics',()=>{
 const raw=resolve(runtime,'add two apples to cart and add bananas to wishlist');
 const wire=resolutionEnvelope(raw,provenance);
 for(const key of ['actions','clauses','relationships','references','slots','graph','ambiguities','requestedActions','confidenceLevel'] as const){
  assert.deepEqual(wire.result[key],raw[key]);
 }
 assert.equal(wire.contractVersion,2);
 assert.deepEqual(wire.provenance,provenance);
 assert.equal('debug' in wire.result,false);
 assert.deepEqual(wire.diagnostics?.debug,raw.debug);
 assert.throws(()=>resolutionEnvelope({...raw,newSemanticField:true},provenance),/Unclassified/);
});

test('purpose browsing removes the unspecified item and its stale links together',()=>{
 for(const text of ['show me products for camping','find products for dinner','find a gift for my mother']){
  const result=resolutionEnvelope(resolve(runtime,text),provenance).result;
  assert.equal(result.status,'RESOLVED',text);
  assert.equal(result.entities?.items,undefined);
  assert.ok(result.actions?.length);
  assert.ok(result.actions!.every(action=>!action.itemIndexes?.length));
  assert.ok(result.relationships?.every(link=>link.from!=='item1'&&link.to!=='item1'));
  assert.ok(result.graph?.nodes.every(node=>node.id!=='item1'&&node.id!=='slot:PRODUCT_TEXT'));
  assert.ok(!result.slots?.some(slot=>slot.code==='PRODUCT_TEXT'));
  assert.equal((result.context?.next as Record<string,unknown>).pendingRequest,undefined);
 }
});

test('generated wire schema rejects incompatible or malformed envelopes',()=>{
 const valid=resolutionEnvelope(resolve(runtime,'show my cart'),provenance);
 for(const change of [
  {...valid,contractVersion:99},
  {...valid,provenance:{...provenance,generationFingerprint:'wrong'}},
  {...valid,provenance:{...provenance,clauseSpanEncoding:'bytes'}},
  {...valid,result:{...valid.result,confidence:'1'}},
  {...valid,result:{...valid.result,confidence:Infinity}},
  {...valid,result:{...valid.result,actions:[{id:'bad'}]}},
  {...valid,result:{...valid.result,executeImmediately:true}},
 ])assert.throws(()=>validateResolutionEnvelope(change),/Invalid language resolution/);
 const compound=resolutionEnvelope(resolve(runtime,'add two apples to cart and add bananas to wishlist'),provenance);
 const dangling=structuredClone(compound);
 dangling.result.entities!.items=[];
 assert.throws(()=>validateResolutionEnvelope(dangling),/invalid action item index/);
 for (const corrupt of [
  (wire: typeof compound) => {wire.result.references=[{expression:'it',kind:'product',resolved:true,target:'item999'}];},
  (wire: typeof compound) => {wire.result.graph!.nodes[0].clauseId='missing';},
  (wire: typeof compound) => {wire.result.intentCount=17;},
  (wire: typeof compound) => {wire.result.requestedActions![0].after=wire.result.requestedActions![0].id;},
  (wire: typeof compound) => {wire.result.requestedActions![0].items=[{}];},
  (wire: typeof compound) => {wire.result.actions![0].id=wire.result.clauses![0].id;},
 ]){
  const malformed=structuredClone(compound);
  corrupt(malformed);
  assert.throws(()=>validateResolutionEnvelope(malformed),/Invalid language resolution semantics/);
 }
});

test('runtime identity includes executable sources, generated schemas and dependency lock',async()=>{
 const path=await mkdtemp(join(tmpdir(),'language-runtime-hash-'));
 try{
  await mkdir(join(path,'src'));
  await writeFile(join(path,'package-lock.json'),'{}');
  await writeFile(join(path,'src/parser.ts'),'export const version=1;');
  await writeFile(join(path,'src/wire.json'),'{}');
  const root=pathToFileURL(path+'/'),first=await runtimeSha256(root);
  await writeFile(join(path,'package.json'),'{"scripts":{"test":"changed"}}');
  assert.equal(await runtimeSha256(root),first);
  await writeFile(join(path,'src/wire.json'),'{"version":2}');
  assert.notEqual(await runtimeSha256(root),first);
  const second=await runtimeSha256(root);
  await writeFile(join(path,'src/parser.ts'),'export const version=2;');
  assert.notEqual(await runtimeSha256(root),second);
 }finally{await rm(path,{recursive:true,force:true});}
});

test('runtime loads exactly the configured deployment artifact and does not fall back',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'language-runtime-data-'));
 const previous=process.env.CLE_DEPLOY_DATA_DIR;
 try{
  process.env.CLE_DEPLOY_DATA_DIR=directory;
  await assert.rejects(loadRuntime(),{code:'ENOENT'});
  const dictionary={...runtime.dictionary,generationFingerprint:'a'.repeat(64)};
  await writeFile(join(directory,'compiled.json'),JSON.stringify(dictionary));
  assert.equal((await loadRuntime()).dictionary.generationFingerprint,dictionary.generationFingerprint);
 }finally{
  if(previous===undefined)delete process.env.CLE_DEPLOY_DATA_DIR;else process.env.CLE_DEPLOY_DATA_DIR=previous;
  await rm(directory,{recursive:true,force:true});
 }
});
