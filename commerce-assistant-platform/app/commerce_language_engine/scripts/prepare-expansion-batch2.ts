/** Bounded recipient/occasion expansion; no product facts or demographic preferences. */
import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {withDictionaryRecognition} from '../src/recognition-rules.ts';
import {canonicalKnowledge,knowledgeHash,type KnowledgeConcept,type KnowledgeRule} from '../src/language-knowledge.ts';
import {compositionPolicyExecutor,compositionExecutor,ruleContract,reviewContentHash,type GovernedRule} from '../src/rule-governance.ts';
import {projectKnowledge} from '../src/knowledge-store.ts';
const {values}=parseArgs({options:{base:{type:'string'},spec:{type:'string'},output:{type:'string'}}});
if(!values.base||!values.spec||!values.output)throw Error('Use --base DICTIONARY --spec FROZEN_SPEC --output NEW_PACK');
const base=JSON.parse(await readFile(values.base,'utf8')),spec=JSON.parse(await readFile(values.spec,'utf8'));
const pack=withDictionaryRecognition(base,()=>{
 const pack=structuredClone(canonicalKnowledge(base.languageKnowledge));if(pack.revision!==11)throw Error('Requires revision 11');pack.revision=12;
 const review=(c:KnowledgeConcept)=>{
  c.aliases.sort();c.metadata={...c.metadata,domains:['commerce'],usage:'explicit_relationship_only',inferencePolicy:'explicit_words_only',doesNotImplyPreferences:true};delete c.metadata.lexicalReview;
  c.metadata.lexicalReview={source:spec.source,author:'codex',reviewer:'codex',method:'ai_assisted',status:'reviewed',reviewedAt:'2026-10-10T00:00:00.000Z',formsSha256:knowledgeHash({kind:c.kind,canonical:c.canonical,aliases:c.aliases}),contentSha256:knowledgeHash(c)};
 };
 for(const [id,canonical,aliases] of spec.roles){const c:KnowledgeConcept={id:'person.'+id,kind:'person',canonical,aliases,metadata:{personType:'role',personRole:'recipient',requiresContext:true}};review(c);pack.concepts.push(c);}
 for(const [id,alias] of spec.occasionAliases){const c=pack.concepts.find(c=>c.id==='occasion.'+id);if(!c)throw Error('Unknown occasion '+id);c.aliases.push(alias);review(c);}
 for(const [marker,targetKind,relation,example] of [['as a present for','person','recipient','my music teacher'],['in celebration of','occasion','occasion','graduation']] as const){
  const rule:KnowledgeRule={id:relation+'.'+marker.replaceAll(' ','_'),marker,targetKind,relation,scope:'product',priority:120,...(targetKind==='person'?{clarifyAlternatives:true,targetMetadata:{personRole:'recipient'}}:{})};
  const row:GovernedRule={family:'relationship',ruleId:rule.id,version:1,language:'en',domain:'commerce',runtime:targetKind==='person'?compositionPolicyExecutor:compositionExecutor,definitionSha256:knowledgeHash(rule),contract:ruleContract('relationship',rule),examples:[`Find flowers ${marker} ${example}`],counterexamples:[`Add flowers ${marker} ${example} to my cart`,`Find flowers ${marker} unknownword`],conflictsWith:[],source:spec.source,author:'codex',changeReason:'Recognize explicit recipient or occasion; never infer preferences or product facts.',status:'reviewed'};
  row.review={reviewer:'codex',method:'ai_assisted',reviewedAt:'2026-10-10T00:00:00.000Z',contentSha256:reviewContentHash(row)};pack.rules.push(rule);pack.ruleGovernance!.push(row);
 }
 return projectKnowledge(base,canonicalKnowledge(pack)).pack;
});
await writeFile(values.output,JSON.stringify(pack,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({revision:pack.revision,concepts:pack.concepts.length,forms:pack.concepts.reduce((n,c)=>n+c.aliases.length+1,0),governedRules:pack.ruleGovernance?.length,packSha256:knowledgeHash(pack),activated:false}));
