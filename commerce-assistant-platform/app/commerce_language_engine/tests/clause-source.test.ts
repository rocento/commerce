import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {loadRuntime} from '../src/runtime.ts';
import {resolve} from '../src/engine.ts';
import type {Context,CorpusCase} from '../src/types.ts';
const runtime=await loadRuntime();
function verifySource(result:ReturnType<typeof resolve>){
 if(!result.clauses?.length)return 0;
 assert.equal(typeof result.clauseSourceText,'string',result.text);
 const source=result.clauseSourceText!;
 for(const clause of result.clauses){
  assert.ok(clause.start>=0&&clause.end<=source.length&&clause.end>clause.start,result.text);
  assert.equal(source.slice(clause.start,clause.end),clause.text,JSON.stringify({text:result.text,source,clause}));
 }
 return result.clauses.length;
}
test('canonical read, purpose and resumed product clauses retain their actual parse source',()=>{
 const cases:[string,Context,string][]=[
  ['show me the shipping status of order 456446',{},'track order 456446'],
  ['show me products for camping',{},'find products'],
  ['shoes',{pendingRequest:'find products'},'find shoes'],
 ];
 for(const [text,context,source] of cases){
  const result=resolve(runtime,text,context);
  assert.ok(verifySource(result)>0,text);assert.equal(result.clauseSourceText,source);
  assert.equal(result.text,text);assert.equal(result.interpretationText,undefined,'Clause source must not replace evidence interpretation text');
 }
});
test('compound collection parser retains its trimmed source and UTF-16 quoted product offsets',()=>{
 const text='  add "📦 milk" to cart and save "🍞 bread" to wishlist!   ',result=resolve(runtime,text);
 assert.equal(result.status,'RESOLVED');assert.equal(verifySource(result),2);
 assert.equal(result.clauseSourceText,text.trim().replace(/[.!?]$/, '').trim());
 assert.equal(result.text,text);assert.equal(result.interpretationText,undefined);
});
test('constraint stripping keeps clause provenance distinct from original evidence offsets',()=>{
 const text='find milk and bread without sugar',result=resolve(runtime,text);
 assert.ok(verifySource(result)>0);assert.notEqual(result.clauseSourceText,text);
 assert.equal(result.interpretationText,undefined);
 for(const constraint of result.entities.requestConstraints??[])assert.equal([...text].slice(constraint.start,constraint.end).join(''),constraint.text);
});
test('clause offsets remain UTF-16 for supplementary Unicode before multiple actions',()=>{
 const text='📦 add milk and bread then deliver tomorrow',result=resolve(runtime,text);
 assert.equal(verifySource(result),2);assert.equal(result.clauseSourceText,text);
 assert.equal(result.clauses![0].start,3);assert.equal(result.clauses![1].start,27);
});
test('representative archived corpus retains exact source slices for every emitted clause',async()=>{
 const input=createReadStream(new URL('../data/corpus.jsonl',import.meta.url)),lines=createInterface({input,crlfDelay:Infinity});
 let examples=0,clauseCount=0;
 try{
  for await(const line of lines){
   if(!line.trim())continue;
   const row=JSON.parse(line) as CorpusCase;
   clauseCount+=verifySource(resolve(runtime,row.text,row.context));
   if(++examples===1024)break;
  }
 }finally{lines.close();input.destroy();}
 assert.equal(examples,1024);assert.ok(clauseCount>0,'Sample must exercise clauses');
});
