import {recognitionSeed} from '../src/recognition-seed.ts';
import {compileRecognitionRules,enterRecognitionRules} from '../src/recognition-rules.ts';
/** One-time Phase 1 migration. Does not import, approve, or activate a release. */
import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {canonicalKnowledge,knowledgeHash,type LanguageKnowledgePack} from '../src/language-knowledge.ts';
import {ruleDefinitions,ruleContract,questionOverlapPairs,knowledgeExecutor,type GovernedRule} from '../src/rule-governance.ts';

export function prepareGovernedKnowledge(input:unknown):LanguageKnowledgePack{
 const pack=canonicalKnowledge(input);
 if(pack.ruleGovernance)throw new Error('Already governed; revise individual rules with version/review checks');
 pack.revision++;
 pack.source='Phase 1: existing English rules plus migration of the legacy inline budget pattern; AI-authored matching fixtures, not independent answer-quality labels.';
 const templates:string[]=[];
 for(const owner of ['','my ','our ','the ','a '])for(const noun of ['budget','limit'])for(const copula of ['',' is',' of'])templates.push(owner+noun+copula+' {amount}');
 pack.budgetRules=[{id:'budget.inline.maximum',templates:templates.sort(),priority:100,output:'maximum_price',scope:'product'}];
 const pick=(kind:string,metadata:Record<string,unknown>={})=>pack.concepts.find(c=>c.kind===kind&&!c.metadata?.ambiguous&&Object.entries(metadata).every(([k,v])=>c.metadata?.[k]===v))!;
 // The executor deliberately refuses context-requiring prefix modifiers. Do
 // not certify a dead rule with a fabricated positive example.
 pack.rules=pack.rules.filter(r=>r.marker!=='modifier'||pack.concepts.some(c=>c.kind===r.targetKind&&!c.metadata?.ambiguous&&!c.metadata?.requiresContext&&Object.entries(r.targetMetadata??{}).every(([k,v])=>c.metadata?.[k]===v)));
 const activity=pick('activity').canonical,recipient=pick('person',{personRole:'recipient'}).canonical;
 const conflicts=questionOverlapPairs(pack);
 pack.ruleGovernance=ruleDefinitions(pack).map(({family,rule})=>{
  let examples:string[],counterexamples:string[];
  if(family==='relationship'){
   const r=rule as LanguageKnowledgePack['rules'][number],concept=pick(r.targetKind,r.targetMetadata);
   if(!concept)throw new Error('No unambiguous example target: '+r.id);
   const prefix=r.marker.startsWith('who ')?'find laptop for '+recipient+' ':'find laptop ';
   examples=[r.marker==='modifier'?'find '+concept.canonical+' laptop for '+activity:prefix+r.marker+' '+concept.canonical];
   counterexamples=['buy laptop '+(r.marker==='modifier'?'':r.marker+' ')+concept.canonical,'find laptop '+r.marker+' qzxunknownphrase'];
  }else if(family==='budget'){
   examples=['I need a laptop for '+activity+' and my limit is $75','find laptop for '+activity+' with our budget of 400 USD'];
   counterexamples=['find laptop for '+activity+' and my limit is not $75','find laptop for '+activity+' but my limit is $75','find laptop for '+activity+' under $40 and my limit is $75','find laptop for '+activity+' if my limit is $75','find laptop for '+activity+' and my limit is $75 per month','That is not my budget.'];
  }else if(family==='question'){
   const r=rule as NonNullable<LanguageKnowledgePack['questionRules']>[number];
   examples=[r.templates[0].replace('{product}','laptop').replace('{other}','tablet').replace('{quantity}','2').replace('{device}',pick('device').canonical)];
   counterexamples=['not '+examples[0],examples[0]+' and checkout'];
  }else{
   const r=rule as NonNullable<LanguageKnowledgePack['utteranceRules']>[number];
   const sample=r.phrases[0].replace('{amount}','$75');
   examples=[r.role==='lead_in'?sample+', what is the price of laptop':sample];
   counterexamples=['not '+examples[0],r.role==='lead_in'?'quick unknown question, what is the price of laptop':examples[0]+' and checkout'];
  }
  return {family,ruleId:rule.id,version:1,language:'en',domain:'commerce',runtime:knowledgeExecutor,definitionSha256:knowledgeHash(rule),contract:ruleContract(family,rule),examples,counterexamples,conflictsWith:family==='question'?conflicts.filter(pair=>pair.includes(rule.id)).map(pair=>pair.find(id=>id!==rule.id)!):[],source:family==='budget'?'src/contextual-language.ts legacy priceTail; Phase 0 exposed inline-limit regression':'Published knowledge revision '+(pack.revision-1)+'; fixtures derived from its definitions',author:'codex',changeReason:family==='budget'?'Move existing inline budget syntax into bounded literal templates':'Add provenance and executable matching examples to existing behavior',status:'draft'} satisfies GovernedRule;
 });
 return canonicalKnowledge(pack);
}
if(process.argv[1]?.endsWith('/prepare-governed-knowledge.ts')){
 enterRecognitionRules(compileRecognitionRules(recognitionSeed()));
const {values}=parseArgs({options:{input:{type:'string'},output:{type:'string'}}});
 if(!values.input||!values.output||values.input===values.output)throw new Error('Use --input BASE_PACK --output NEW_PACK');
 const input=JSON.parse(await readFile(values.input,'utf8'));
 await writeFile(values.output,JSON.stringify(prepareGovernedKnowledge(input.languageKnowledge??input),null,2)+'\n',{flag:'wx'});
}

