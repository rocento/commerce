import {recognitionSeed,recognitionFixture} from './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from '../src/compiler.ts';
import {resolve} from '../src/engine.ts';
import {canonicalKnowledge,compileKnowledge,knowledgeHash} from '../src/language-knowledge.ts';
import {assertKnowledgeReviewed,assertKnowledgeUpgrade,ruleContract,reviewContentHash} from '../src/rule-governance.ts';
import {budgetSuffix} from '../src/budget-rules.ts';
import {contextualShoppingSearch,priceTail} from '../src/contextual-language.ts';
import {explainKnowledge} from '../src/knowledge-explanation.ts';
import {questionRead} from '../src/question-language.ts';
const base=(recognitionFixture(JSON.parse(readFileSync(new URL('../data/compiled.json',import.meta.url),'utf8'))));
const pack=canonicalKnowledge(JSON.parse(readFileSync(new URL('../data/knowledge/shopping-en-governed-v1.json',import.meta.url),'utf8')));
const compiled=compile({...base,languageKnowledge:pack}),index=compiled.languageKnowledge!;
const draft=()=>{const p=structuredClone(pack);for(const r of p.ruleGovernance!){r.status='draft';delete r.review;}return p;};
function rebind(p:typeof pack,id:string){const rule=[...p.rules,...p.utteranceRules??[],...p.questionRules??[],...p.budgetRules??[]].find(r=>r.id===id)!;const row=p.ruleGovernance!.find(r=>r.ruleId===id)!;row.definitionSha256=knowledgeHash(rule);row.contract=ruleContract(row.family,rule);}

test('all governed fixtures execute and review hashes survive canonical round trips',()=>{
 assert.equal(pack.ruleGovernance!.length,68);assertKnowledgeReviewed(pack);
 assert.deepEqual(canonicalKnowledge(pack),pack);compile({...base,languageKnowledge:pack});
 const changed=structuredClone(pack);changed.ruleGovernance![0].examples[0]+=' altered';
 assert.throws(()=>canonicalKnowledge(changed),/stale rule review/);
 const changedRule=structuredClone(pack);changedRule.budgetRules![0].priority++;
 assert.throws(()=>canonicalKnowledge(changedRule),/definition\/contract mismatch/);
 const rebound=structuredClone(pack);rebound.ruleGovernance![0].source='changed attribution';
 assert.throws(()=>canonicalKnowledge(rebound),/stale rule review/);
});
test('drafts cannot publish and missing/foreign metadata cannot bypass governance',()=>{
 const p=draft();compile({...base,languageKnowledge:p});assert.throws(()=>assertKnowledgeReviewed(p),/reviewed knowledge/);
 for(const mutation of [
  (p:typeof pack)=>{delete p.ruleGovernance;},
  (p:typeof pack)=>{p.ruleGovernance!.pop();},
  (p:typeof pack)=>{p.ruleGovernance![0].runtime='future-runtime';},
  (p:typeof pack)=>{p.ruleGovernance![0].ruleId='nonexistent';},
  (p:typeof pack)=>{p.ruleGovernance![0].conflictsWith=['unknown'];},
 ]){const changed=draft();mutation(changed);assert.throws(()=>canonicalKnowledge(changed));}
});
test('negative fixtures and silently invalidated positive examples block compilation',()=>{
 const p=draft(),row=p.ruleGovernance!.find(r=>r.family==='budget')!;
 row.counterexamples=['find laptop for online classes and my limit is $75'];
 assert.throws(()=>compile({...base,languageKnowledge:p}),/counterexample matched/);
 row.counterexamples=['That is not my budget.'];row.examples=['That is not my budget.'];
 assert.throws(()=>compile({...base,languageKnowledge:p}),/Contradictory/);
 row.examples=['find laptop for qzxunknown and my limit is $75']; // Unknown use is retained, never dropped.
 const contextual=contextualShoppingSearch(index,row.examples[0]);assert.equal(contextual?.unresolved?.[0].text,'for qzxunknown');
 row.examples=['buy laptop for online classes and my limit is $75'];
 assert.throws(()=>compile({...base,languageKnowledge:p}),/Positive rule example failed/);
});
test('literal syntax, bounded slots, duplicates and overlapping predicates fail before publication',()=>{
 for(const template of ['(my|our) limit is {amount}','my limit is {code}','my limit is {amount} {amount}','my limit is .*','my limit is {amount}; checkout']){
  const p=draft();p.budgetRules![0].templates=[template];assert.throws(()=>canonicalKnowledge(p),/budget template/);
 }
 const p=draft();p.budgetRules![0].templates.push(p.budgetRules![0].templates[0]);assert.throws(()=>canonicalKnowledge(p),/Duplicate budget/);
 const overlap=draft(),r=structuredClone(overlap.rules.find(r=>r.id==='for.recipient')!);r.id='overlapping.recipient';delete r.targetMetadata;overlap.rules.push(r);
 const metadata=structuredClone(overlap.ruleGovernance!.find(r=>r.ruleId==='for.recipient')!);metadata.ruleId=r.id;overlap.ruleGovernance!.push(metadata);rebind(overlap,r.id);
 assert.throws(()=>canonicalKnowledge(overlap),/Overlapping relationship/);
 const undeclared=draft();undeclared.ruleGovernance!.find(r=>r.ruleId==='question.price')!.conflictsWith=[];assert.throws(()=>canonicalKnowledge(undeclared),/Undeclared overlapping/);
 assert.equal(questionRead(pack,'what is the current price of laptop made of'),undefined);
});
test('changed definitions require both a pack revision and rule version; no governance downgrade',()=>{
 const next=draft();assert.throws(()=>assertKnowledgeUpgrade(pack,next),/new revision/);
 next.revision++;next.budgetRules![0].priority++;rebind(next,'budget.inline.maximum');
 assert.throws(()=>assertKnowledgeUpgrade(pack,next),/new version/);
 next.ruleGovernance!.find(r=>r.family==='budget')!.version++;assertKnowledgeUpgrade(pack,next);
 assert.throws(()=>assertKnowledgeUpgrade(pack,undefined),/removed or downgraded/);
});
test('all 30 templates preserve previous numeric outputs across currencies and separators',()=>{
 for(const template of pack.budgetRules![0].templates)for(const prefix of [' ',' and ',' with ',' , and '])for(const amount of ['$40','75 USD','EUR 120.50','1,200 EGP']){
  const body='laptop for online classes'+prefix+template.replace('{amount}',amount);
  const old=priceTail(body),next=priceTail(body,index);
  assert.deepEqual({body:next.body,tail:next.tail},old,body);
 }
 for(const text of ['I need a laptop for online classes and my limit is $40.','I need a laptop for video editing and my limit is $75.']){
  assert.deepEqual(resolve(compiled,text).entities,resolve(compile(base),text).entities);
 }
});
test('disabled templates do not fall back; negatives and multiple limits are not consumed',()=>{
 const text='laptop for online classes and my limit is $75';
 assert.equal(priceTail(text,{...index,budgetRules:[]}).tail,'');
 for(const suffix of ['if my limit is $75','not my limit is $75','but my limit is $75','and my limit is not $75','and my limit is $75 per month'])assert.equal(budgetSuffix(pack.budgetRules!,'laptop '+suffix),undefined,suffix);
 for(const text of ['find laptop for online classes under $40 and my limit is $75','find laptop for online classes and my limit is $75. My budget is $50 now.','buy laptop for online classes and my limit is $75','find "laptop for online classes and my limit is $75"'])assert.equal(contextualShoppingSearch(index,text),undefined,text);
});
test('diagnostics retain real Unicode spans, rule versions and AI review provenance',()=>{
 const text='  I need a 𐐀laptop for online classes and my limit is $75.';
 const report=explainKnowledge(compiled,text),budget=report.evidence.find(row=>row.family==='budget');
 assert.ok(budget);assert.equal(budget.ruleId,'budget.inline.maximum');assert.equal(budget.version,1);assert.equal(budget.reviewMethod,'ai_assisted');
 for(const row of report.evidence)assert.equal([...text].slice(row.start,row.end).join(''),row.text);
 assert.equal(explainKnowledge(compiled,'buy laptop for online classes and my limit is $75').evidence.some(r=>r.family==='budget'),false);
});
test('an inline budget retains product/use context when the shopper corrects the amount',()=>{
 const first=resolve(compiled,'I need a laptop for video editing and my limit is $75.');
 const next=resolve(compiled,'Actually my budget is $50 now.',first.context.next);
 assert.equal(next.status,'RESOLVED');assert.equal(next.intent,'PRODUCT_SEARCH');
 assert.equal(next.entities.productText,'laptop');assert.deepEqual(next.entities.price,{operator:'<=',value:50,currency:'USD'});
 assert.ok(next.entities.shoppingContext.relations.some((r:any)=>r.relation==='intended_use'&&r.value==='video editing'));
});
