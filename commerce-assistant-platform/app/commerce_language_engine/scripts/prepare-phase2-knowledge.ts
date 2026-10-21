/** Curated additive English release. No activation, synthetic count padding, or facts. */
import {readFile,writeFile} from 'node:fs/promises';
import {canonicalKnowledge,knowledgeHash,knowledgeTokens,type KnowledgeConcept,type KnowledgeKind,type KnowledgeRule} from '../src/language-knowledge.ts';
import {ruleDefinitions,ruleContract,compositionExecutor,reviewContentHash,type GovernedRule} from '../src/rule-governance.ts';
import {compile} from '../src/compiler.ts';
const pack=canonicalKnowledge(JSON.parse(await readFile(new URL('../data/knowledge/shopping-en-governed-v1.json',import.meta.url),'utf8')));
const curated=JSON.parse(await readFile(new URL('../data/knowledge/phase2-vocabulary.json',import.meta.url),'utf8'));
const dictionary=JSON.parse(await readFile(new URL('../data/compiled.json',import.meta.url),'utf8'));
pack.revision=7;pack.source='Phase 2 reviewed English vocabulary/composition; source phase2-curated-english-v1 and published CATEGORY aliases. No product facts.';
const changed=new Set<string>(),slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
function add(kind:KnowledgeKind,canonical:string,aliases:string[],metadata:Record<string,unknown>={}){
 const previous=pack.concepts.find(c=>c.kind===kind&&[c.canonical,...c.aliases].some(form=>knowledgeTokens(form).join(' ')===knowledgeTokens(canonical).join(' ')));
 const id=previous?.id??kind+'.'+slug(canonical);
 const concept:KnowledgeConcept=previous??{id,kind,canonical,aliases:[],metadata:{requiresContext:true,...metadata}};
 for(const alias of [canonical,...aliases])if(![concept.canonical,...concept.aliases].some(a=>knowledgeTokens(a).join(' ')===knowledgeTokens(alias).join(' ')))concept.aliases.push(alias);
 concept.metadata={...concept.metadata,...metadata};if(!previous)pack.concepts.push(concept);changed.add(id);
}
for(const kind of ['activity','material','person','occasion','device','unit','dimension'] as KnowledgeKind[])for(const [word,...aliases] of curated[kind]){
 const dimension=kind==='dimension'?(['weight'].includes(word)?'mass':word==='volume'?'volume':'length'):kind==='unit'?(['gram','kilogram','milligram','ounce','pound'].includes(word)?'mass':['milliliter','liter'].includes(word)?'volume':['millimeter','centimeter','meter','inch','foot'].includes(word)?'length':undefined):undefined;
 add(kind,word,aliases,{domains:kind==='material'?['electronics','jewelry','grocery','pharmacy']:['commerce'],usage:kind==='product'||kind==='unit'||kind==='dimension'?'lexical_annotation_only':'explicit_relationship_only',...(kind==='person'?{personRole:'recipient'}:{}),...(kind==='device'?{requiresExactModel:false}:{}),...(kind==='unit'?{unitKind:dimension?'measure':'package'}:{}),...(dimension?{dimension}:{})});
}
for(const [id,aliases] of Object.entries(curated.aliases)){const c=pack.concepts.find(c=>c.id===id)!;add(c.kind,c.canonical,aliases as string[],{domains:['commerce'],usage:'explicit_relationship_only'});}
const categories=new Map<string,{forms:string[];domains:Set<string>}>();
for(const term of dictionary.entity_terms)if(term.type==='CATEGORY'&&['ELECTRONICS','GROCERY','JEWELRY','PHARMACY'].includes(term.industry)){
 const key=term.value.replaceAll('_',' '),group=categories.get(key)??{forms:[],domains:new Set<string>()};group.forms.push(term.alias);group.domains.add(term.industry.toLowerCase());categories.set(key,group);
}
for(const [word,{forms,domains}] of categories)add('product',word,forms,{domains:[...domains].sort(),usage:'lexical_annotation_only',source:'published CATEGORY terms in revision-5 baseline; no merchant availability inference'});
// Every shared spelling is explicit. Kind/marker scope decides its meaning;
// an unscoped matching spelling must never choose material vs color vs product.
const surfaces=new Map<string,KnowledgeConcept[]>();
for(const c of pack.concepts)for(const form of new Set([c.canonical,...c.aliases].map(x=>knowledgeTokens(x).join(' ')))){const list=surfaces.get(form)??[];list.push(c);surfaces.set(form,list);}
for(const [surface,owners] of surfaces)if(owners.length>1)for(const c of owners){c.metadata??={};c.metadata.sharedAliases=[...new Set([...(c.metadata.sharedAliases as string[]??[]),surface])];changed.add(c.id);}
for(const c of pack.concepts)if(changed.has(c.id)){
 c.aliases.sort();c.metadata??={};
 c.metadata.domains??=['commerce'];c.metadata.usage??='explicit_relationship_only';
 c.metadata.lexicalReview={source:'phase2-curated-english-v1',author:'codex',reviewer:'codex',method:'ai_assisted',status:'reviewed',reviewedAt:curated.source.createdAt,formsSha256:knowledgeHash({kind:c.kind,canonical:c.canonical,aliases:[...c.aliases].sort()})};
 (c.metadata.lexicalReview as Record<string,unknown>).contentSha256=knowledgeHash({...c,aliases:[...c.aliases].sort(),metadata:Object.fromEntries(Object.entries(c.metadata).filter(([key])=>key!=='lexicalReview'))});
}
const additions:KnowledgeRule[]=[];
for(const marker of ['made of','made from','with'])additions.push({id:'material.'+slug(marker),marker,targetKind:'material',relation:'material',scope:'product',priority:120});
for(const marker of ['without','except','except for','excluding','but not','with no'])for(const kind of ['color','material'] as const)additions.push({id:kind+'.exclude.'+slug(marker),marker,targetKind:kind,relation:kind,scope:'product',priority:120,negated:true});
additions.push({id:'device.with.ambiguous',marker:'with',targetKind:'device',relation:'compatibility_target',scope:'product',priority:120,requiresClarification:true});
additions.push({id:'activity.to_do',marker:'to do',targetKind:'activity',relation:'intended_use',scope:'product',priority:120});
pack.rules.push(...additions);
pack.budgetRules!.push({id:'budget.inline.range',templates:['my budget is between {min} and {max}','my budget is from {min} to {max}','our budget is between {min} and {max}','our budget is from {min} to {max}','the price range is between {min} and {max}'],priority:120,scope:'product',output:'price_range'});
pack.budgetRules!.push({id:'budget.inline.spending_limit',templates:['my spending limit is {amount}','our spending limit is {amount}','my maximum budget is {amount}','a budget of {amount}'],priority:120,scope:'product',output:'maximum_price'});
// a budget of is already covered by the original rule.
pack.budgetRules!.at(-1)!.templates=pack.budgetRules!.at(-1)!.templates.filter(x=>!pack.budgetRules![0].templates.includes(x));
const old=new Map(pack.ruleGovernance!.map(r=>[r.family+':'+r.ruleId,r]));
pack.ruleGovernance=ruleDefinitions(pack).map(({family,rule})=>{
 const previous=old.get(family+':'+rule.id);if(previous)return previous;
 let examples:string[],counterexamples:string[];
 if(family==='relationship'){
  const r=rule as KnowledgeRule,target=r.targetKind==='material'?'cotton':r.targetKind==='color'?'green':r.targetKind==='device'?'iPhone 13':'bookkeeping';
  examples=['find scarf '+r.marker+' '+target];
  counterexamples=['buy scarf '+r.marker+' '+target,'find scarf '+r.marker+' unknownword'];
  if(r.negated)counterexamples.push('find scarf not '+r.marker+' '+target);
 }else{
  examples=rule.id==='budget.inline.range'?['find laptop for gaming and my budget is between $100 and $200']:['find laptop for gaming and my spending limit is $300'];
  counterexamples=['find laptop for gaming and my budget is not $100','buy laptop for gaming and my budget is between $100 and $200'];
 }
 const row:GovernedRule={family,ruleId:rule.id,version:1,language:'en',domain:'commerce',runtime:compositionExecutor,definitionSha256:knowledgeHash(rule),contract:ruleContract(family,rule),examples,counterexamples,conflictsWith:[],source:'phase2-curated-english-v1; explicit English composition',author:'codex',changeReason:'Add scoped lexical composition while preserving merchant-evidence requirements',status:'reviewed'};
 row.review={reviewer:'codex',method:'ai_assisted',reviewedAt:curated.source.createdAt,contentSha256:reviewContentHash(row)};return row;
});
const canonical=canonicalKnowledge(pack);compile({...dictionary,languageKnowledge:canonical});
const output=new URL('../data/knowledge/shopping-en-phase2-v1.json',import.meta.url);
await writeFile(output,JSON.stringify(canonical,null,2)+'\n');
console.log(JSON.stringify({revision:canonical.revision,concepts:canonical.concepts.length,forms:canonical.concepts.reduce((n,c)=>n+1+c.aliases.length,0),governedRules:canonical.ruleGovernance!.length,reviewedConcepts:changed.size}));
