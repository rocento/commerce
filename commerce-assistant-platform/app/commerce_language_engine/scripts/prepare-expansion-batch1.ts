/** First-party work/study wording; additive candidate only, never activation. */
import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {withDictionaryRecognition} from '../src/recognition-rules.ts';
import {canonicalKnowledge,knowledgeHash,type KnowledgeRule} from '../src/language-knowledge.ts';
import {compositionExecutor,ruleContract,reviewContentHash,assertKnowledgeUpgrade,type GovernedRule} from '../src/rule-governance.ts';
import {projectKnowledge} from '../src/knowledge-store.ts';
const {values}=parseArgs({options:{base:{type:'string'},output:{type:'string'}}});
if(!values.base||!values.output)throw new Error('Use --base DICTIONARY --output NEW_PACK');
const base=JSON.parse(await readFile(values.base,'utf8'));
const additions:Record<string,string[]>={
 'activity.online_classes':['joining remote classes','attending virtual lessons'],
 'activity.note_taking':['taking lecture notes','making study notes'],
 'activity.spreadsheets':['working on spreadsheets','editing spreadsheets'],
 'activity.video_calls':['joining video meetings','attending video meetings'],
 'activity.essay_writing':['writing school essays','drafting essays'],
 'activity.office_work':['everyday office work','daily office tasks'],
 'activity.presentations':['preparing presentations','showing presentations'],
 'activity.research_writing':['writing academic papers','drafting research papers'],
};
const pack=withDictionaryRecognition(base,()=>{
 const previous=canonicalKnowledge(base.languageKnowledge),pack=structuredClone(previous);
 if(previous.revision!==10)throw new Error('This bounded expansion requires reviewed revision10');
 pack.revision=11;
 for(const [id,aliases] of Object.entries(additions)){
  const c=pack.concepts.find(c=>c.id===id);if(!c)throw new Error('Missing base concept: '+id);
  c.aliases=[...new Set([...c.aliases,...aliases])].sort();
  c.metadata={...c.metadata,domains:['commerce'],usage:'explicit_relationship_only',inferencePolicy:'request_only',requiresProductEvidenceForSuitability:true};
  c.metadata.lexicalReview={source:'First-party English work/study wording, expansion-batch1-20261010; lexical equivalence only, no product facts',author:'codex',reviewer:'codex',method:'ai_assisted',status:'reviewed',reviewedAt:'2026-10-10T00:00:00.000Z',formsSha256:knowledgeHash({kind:c.kind,canonical:c.canonical,aliases:c.aliases}),contentSha256:knowledgeHash({...c,metadata:Object.fromEntries(Object.entries(c.metadata).filter(([k])=>k!=='lexicalReview'))})};
 }
 for(const marker of ['to help with','for practicing','for practising']){
  const rule:KnowledgeRule={id:'activity.'+marker.replaceAll(' ','_'),marker,targetKind:'activity',relation:'intended_use',scope:'product',priority:120};
  const row:GovernedRule={family:'relationship',ruleId:rule.id,version:1,language:'en',domain:'commerce',runtime:compositionExecutor,definitionSha256:knowledgeHash(rule),contract:ruleContract('relationship',rule),examples:[`Find a tablet ${marker} note taking`],counterexamples:[`Add a tablet ${marker} note taking to my cart`,`Find a tablet ${marker} unknownword`],conflictsWith:[],source:'First-party English work/study purpose composition, expansion-batch1-20261010',author:'codex',changeReason:'Recognize explicit shopper purpose without claiming a product is suitable.',status:'reviewed'};
  row.review={reviewer:'codex',method:'ai_assisted',reviewedAt:'2026-10-10T00:00:00.000Z',contentSha256:reviewContentHash(row)};
  pack.rules.push(rule);pack.ruleGovernance!.push(row);
 }
 const result=canonicalKnowledge(pack);assertKnowledgeUpgrade(previous,result);projectKnowledge(base,result);return result;
});
await writeFile(values.output,JSON.stringify(pack,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({revision:pack.revision,concepts:pack.concepts.length,forms:pack.concepts.reduce((n,c)=>n+1+c.aliases.length,0),governedRules:pack.ruleGovernance!.length,packSha256:knowledgeHash(pack),modifiedConcepts:Object.keys(additions),activated:false}));
