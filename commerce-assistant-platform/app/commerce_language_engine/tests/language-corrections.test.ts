import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.ts';
import {buildKnowledge} from '../src/knowledge.ts';
import {resolve} from '../src/engine.ts';
import {correctionProposals,editCost} from '../src/language-corrections.ts';
const compiled=compile(buildKnowledge());
test('single read typo recovery preserves original text and numeric constraints',()=>{
 for(const [text,intent] of [['serach milk under 10.50 EGP','PRODUCT_SEARCH'],['shwo my cart','VIEW_CART'],['browes headphones','PRODUCT_SEARCH'],['recommennd milk','PRODUCT_RECOMMEND']]){
  const r=resolve(compiled,text);assert.equal(r.status,'RESOLVED',text);assert.equal(r.intent,intent,text);assert.equal(r.text,text);
  assert.ok(r.correctionEvidence?.candidates.some(c=>c.accepted&&c.reason==='validated_single_read'));
 }
 assert.equal(resolve(compiled,'serach milk under 10.50 EGP').entities.price?.value,10.5);
});
test('legacy correction does not rewrite product arguments',()=>{
 const r=resolve(compiled,'find mi ordar ad');assert.equal(r.entities.productText,'mi ordar ad');assert.equal(r.correctionEvidence,undefined);
 assert.equal(resolve(compiled,'wheres mi ordar').intent,'TRACK_ORDER');
});
test('destructive typo and negated add cannot produce a positive mutation',()=>{
 const r=resolve(compiled,'cancle my order');assert.equal(r.status,'NEEDS_CONTEXT');assert.equal(r.intent,null);assert.ok(r.correctionEvidence?.candidates.every(c=>!c.accepted));
 assert.notEqual(resolve(compiled,'dont ad milk').intent,'ADD_TO_CART');
});
test('substitutions and incomplete compound recovery stay unaccepted',()=>{
 for(const text of ['snow my cart','please serach milk and add two'])assert.ok(resolve(compiled,text).correctionEvidence?.candidates.every(c=>!c.accepted),text);
});
test('catalog proposals are bounded suggestions with original codepoint spans',()=>{
 const text='find 😀 bannnas 2 10.50 EGP AB-012 APL "bannnas" without nuts';
 const trace=correctionProposals(compiled,text,['bananas','banana','nuts']);
 assert.ok(trace.candidates.length>0);
 for(const c of trace.candidates){assert.equal([...text].slice(c.start,c.end).join(''),c.original);assert.equal(c.original,'bannnas');assert.equal(c.accepted,false);}
 assert.equal(correctionProposals(compiled,'find '+ 'x'.repeat(4000)).truncated,true);
 assert.equal(correctionProposals(compiled,'find bannnas',Array(257).fill('banana')).truncated,true);
 assert.ok(correctionProposals(compiled,'find '+Array(40).fill('bannnas').join(' '),['banana','bananas']).candidates.length<=8);
});
test('edit ranking handles insertion and transposition without claiming probability',()=>{
 assert.equal(editCost('serach','search'),1);assert.equal(editCost('recommennd','recommend'),1);assert.equal(editCost('a'.repeat(25),'a'),25);
});
test('missing letters stay proposals because short valid words can resemble commands',()=>{
 const r=resolve(compiled,'fin tea');assert.notEqual(r.status,'RESOLVED');
 assert.ok(r.correctionEvidence?.candidates.every(c=>!c.accepted));
 assert.equal(r.correctionEvidence?.candidates[0].reason,'missing_letter_requires_clarification');
});
test('unresolved leading typo cannot be discarded in favor of a later write',()=>{
 for(const text of ['serach milk then delete my cart','serach milk and remove bread from cart']){
  const r=resolve(compiled,text);assert.equal(r.status,'NEEDS_CONTEXT',text);assert.equal(r.intent,null,text);
  assert.ok(r.correctionEvidence?.candidates.every(c=>!c.accepted));
 }
});
test('word-boundary proposals are confined to command heads and remain unaccepted',()=>{
 for(const [text,from,to] of [['fi nd milk','fi nd','find'],['please sh ow my cart','sh ow','show'],['showmy cart','showmy','show my'],['trackmy order','trackmy','track my']]){
  const trace=correctionProposals(compiled,text);
  const c=trace.candidates.find(c=>c.reason==='word_boundary_requires_clarification');
  assert.ok(c,text);assert.equal(c.original,from);assert.equal(c.candidate,to);assert.equal(c.accepted,false);
  assert.equal([...text].slice(c.start,c.end).join(''),from);
  assert.ok(resolve(compiled,text).correctionEvidence?.candidates.every(c=>!c.accepted));
 }
 for(const text of ['find fi nd milk','find showmy cart','find 😀 sh ow milk','searchlight','searchmilk','Showmy cart','fi-nd milk','fi 2 nd milk','fi\nnd milk']){
  assert.ok(correctionProposals(compiled,text).candidates.every(c=>c.reason!=='word_boundary_requires_clarification'),text);
 }
});
test('word-boundary proposals cannot let a later write swallow the leading request',()=>{
 const r=resolve(compiled,'fi nd milk then delete my cart');assert.equal(r.status,'NEEDS_CONTEXT');assert.equal(r.intent,null);
 assert.ok(r.correctionEvidence?.candidates.every(c=>!c.accepted));
});
test('trusted catalog adapter enforces scope and protected spans without accepting names',async()=>{
 const {scopedCatalogProposals}=await import('../src/language-corrections.ts');
 const vocabulary={tenantId:'tenant-a',revision:'1',terms:['bananas','banana','adidas'],protectedTerms:['adiddas']};
 const text='find 😀 bannnas adiddas AB-012 10.50';
 const result=scopedCatalogProposals(compiled,text,'tenant-a',vocabulary,[]);
 assert.ok(result.candidates.length);assert.ok(result.candidates.every(c=>c.original==='bannnas'&&!c.accepted));
 const start=[...text.slice(0,text.indexOf('bannnas'))].length;
 assert.equal(scopedCatalogProposals(compiled,text,'tenant-a',vocabulary,[{start,end:start+7}]).candidates.length,0);
 assert.throws(()=>scopedCatalogProposals(compiled,text,'tenant-b',vocabulary,[]),/scope/);
 assert.throws(()=>scopedCatalogProposals(compiled,text,'tenant-a',vocabulary,[{start:0,end:999}]),/span/);
 for(const text of ['find bannnas without nuts','deliver bannnas to broadway','find bannnas in may','dont find bannnas'])assert.equal(scopedCatalogProposals(compiled,text,'tenant-a',vocabulary,[]).candidates.length,0,text);
});
test('deleting an ordinary suffix cannot turn a legitimate adjective into a command',()=>{
 const trace=correctionProposals(compiled,'showy cart');
 assert.ok(trace.candidates.every(c=>!c.accepted));
 assert.equal(trace.candidates[0]?.reason,'extra_letter_requires_clarification');
 assert.ok(resolve(compiled,'showy cart').correctionEvidence?.candidates.every(c=>!c.accepted));
});
