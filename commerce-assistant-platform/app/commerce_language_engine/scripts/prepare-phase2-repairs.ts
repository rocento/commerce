/** A separate revision: preserve the original pack, expectations and evaluation. */
import {readFile,writeFile} from 'node:fs/promises';
import {canonicalKnowledge,knowledgeHash,type KnowledgeRule} from '../src/language-knowledge.ts';
import {ruleDefinitions,ruleContract,compositionPolicyExecutor,reviewContentHash,type GovernedRule,assertKnowledgeUpgrade} from '../src/rule-governance.ts';
import {compile} from '../src/compiler.ts';
const before=canonicalKnowledge(JSON.parse(await readFile(new URL('../data/knowledge/shopping-en-phase2-v1.json',import.meta.url),'utf8'))),pack=structuredClone(before);
const reviewedAt='2026-10-10T00:00:00.000Z',source='phase2-validation-repairs-v1; collective ownership, recipient alternatives and explicit compatibility evidence';
pack.revision=8;pack.source=source;
for(const id of ['person.family','person.household','person.team']){
 const c=pack.concepts.find(c=>c.id===id)!;c.metadata={...c.metadata,collectiveRecipient:true,domains:['commerce'],usage:'explicit_relationship_only'};
 delete c.metadata.lexicalReview;
 const contentSha256=knowledgeHash({...c,aliases:[...c.aliases].sort()});
 c.metadata.lexicalReview={source,author:'codex',reviewer:'codex',method:'ai_assisted',status:'reviewed',reviewedAt,formsSha256:knowledgeHash({kind:c.kind,canonical:c.canonical,aliases:[...c.aliases].sort()}),contentSha256};
}
pack.rules.push({id:'for.possessive_collective',marker:'for',targetKind:'person',relation:'recipient',scope:'product',priority:130,targetMetadata:{collectiveRecipient:true},targetPossessive:true,clarifyAlternatives:true});
for(const rule of pack.rules){
 if(rule.marker==='for'&&rule.targetKind==='person')rule.clarifyAlternatives=true;
 if(['compatible.with.device','device.that_works_with','device.to_use_with'].includes(rule.id))rule.requiresClarification=true;
}
const old=new Map(before.ruleGovernance!.map(r=>[r.family+':'+r.ruleId,r]));
pack.ruleGovernance=ruleDefinitions(pack).map(({family,rule})=>{
 const previous=old.get(family+':'+rule.id);if(previous?.definitionSha256===knowledgeHash(rule))return previous;
 const relation=rule as KnowledgeRule;
 const examples=rule.id==='for.possessive_collective'?['find bread for my family','find bread for our household and team']:previous!.examples;
 const counterexamples=rule.id==='for.possessive_collective'?['find bread for families','find bread for my unknownword','buy bread for my family']:previous!.counterexamples;
 const row:GovernedRule={family,ruleId:rule.id,version:(previous?.version??0)+1,language:'en',domain:'commerce',runtime:compositionPolicyExecutor,definitionSha256:knowledgeHash(rule),contract:ruleContract(family,rule),examples,counterexamples,conflictsWith:previous?.conflictsWith??[],source,author:'codex',changeReason:relation.targetPossessive?'An explicit possessive collective identifies a recipient group, without inferring demographic requirements':relation.clarifyAlternatives?'Unselected recipient alternatives require clarification':'Explicit compatibility predicates need catalog evidence before resolution',status:'reviewed'};
 row.review={reviewer:'codex',method:'ai_assisted',reviewedAt,contentSha256:reviewContentHash(row)};return row;
});
const canonical=canonicalKnowledge(pack);assertKnowledgeUpgrade(before,canonical);
const dictionary=JSON.parse(await readFile(new URL('../data/compiled.json',import.meta.url),'utf8'));compile({...dictionary,languageKnowledge:canonical});
await writeFile(new URL('../data/knowledge/shopping-en-phase2-v2.json',import.meta.url),JSON.stringify(canonical,null,2)+'\n');
console.log(JSON.stringify({revision:canonical.revision,concepts:canonical.concepts.length,governedRules:canonical.ruleGovernance!.length,modifiedRules:canonical.ruleGovernance!.filter(r=>old.get(r.family+':'+r.ruleId)?.definitionSha256!==r.definitionSha256).map(r=>({id:r.ruleId,version:r.version}))}));
