import {compileRecognitionRules,withRecognitionRules,type RecognitionRuntime} from './recognition-rules.ts';
import {compileKnowledge,type KnowledgeIndex} from './language-knowledge.ts';
import {validateRuleExamples} from './rule-examples.ts';
import {rocentoDictionary} from './rocento-capabilities.ts';
import {normalize} from './normalize.ts';
import {states} from './dictionary-schema.ts';
import type {Dictionary,Group,SemanticCompositionRule,SemanticAmbiguity,ReferenceRule} from './types.ts';
export type Compiled = {recognition:RecognitionRuntime; languageKnowledge?:KnowledgeIndex; dictionary:Dictionary; schemaVersion:number; index:Map<string,{group:string;tokens:string[]}[]>; diagnostics:string[]; patternsByIntent:Map<string,Dictionary['patterns']>;compositionBySignature:Map<string,SemanticCompositionRule[]>;referenceByExpression:Map<string,ReferenceRule[]>;ambiguitiesByTerm:Map<string,SemanticAmbiguity[]>};
export function compile(dictionary:Dictionary):Compiled {
 const recognition=compileRecognitionRules(dictionary.recognitionRules);
 return withRecognitionRules(recognition,()=>compileScoped(dictionary,recognition));
}
function compileScoped(dictionary:Dictionary,recognition:RecognitionRuntime):Compiled {
 dictionary=rocentoDictionary(dictionary);
 dictionary.recognitionRules=recognition.rules;
 const errors:string[]=[]; const diagnostics:string[]=[];
 if(!Array.isArray(dictionary.entity_terms))throw new Error('Legacy dictionary: regenerate with separate entity terms before compiling');
 const codes=new Set(dictionary.intents.map(i=>i.code)); const groups=new Map<string,Group>();
 const semantic=dictionary.semanticModel;
 if(dictionary.schemaVersion!==undefined&&(!Number.isInteger(dictionary.schemaVersion)||dictionary.schemaVersion<1||dictionary.schemaVersion>2))errors.push('Unsupported dictionary schema version');
 if(codes.size!==dictionary.intents.length)errors.push('Duplicate intent codes');
 const index:Compiled['index']=new Map(); const owners=new Map<string,Set<string>>();
 for(const g of dictionary.groups) {
   if(g.category==='CATEGORY')errors.push('Catalog category must be stored in entity_terms: '+g.code);
   if(groups.has(g.code))errors.push('Duplicate group '+g.code);groups.set(g.code,g);
   if(!g.terms.length)errors.push('Empty group '+g.code);
   const seen=new Set<string>();
   for(const term of g.terms) {
     const n=normalize(term);
     const review=g.termMetadata?.[n]?.enrichment;
     if(review!==undefined&&(!review||review.schemaVersion!==1||review.reviewState!=='approved'||review.language!=='en'||review.scope!=='global'||review.sense!==g.code||!review.packId||!review.reviewedBy||!Number.isSafeInteger(review.revision)||review.revision<1))errors.push('Invalid vocabulary review '+g.code+': '+n);
     if(!n) {errors.push('Empty term '+g.code);continue;}
     if(seen.has(n)){diagnostics.push('Duplicate normalized term '+g.code+': '+n);continue;} seen.add(n);
     const tokens=n.split(' '); const bucket=index.get(tokens[0])??[];bucket.push({group:g.code,tokens});index.set(tokens[0],bucket);
     const set=owners.get(n)??new Set();set.add(g.code);owners.set(n,set);
   }
 }
 for(const i of dictionary.intents) {
  for(const rule of [{code:'primary',conditions:i.conditions,states:i.states},...(i.alternativeRules??[])]) {
   if(rule.states?.some(s=>!states.includes(s)))errors.push('Invalid rule state '+i.code);
   if(!rule.conditions.some(c=>['REQUIRED','POSITIVE'].includes(c.kind)))errors.push('Insufficient evidence '+i.code);
   for(const c of rule.conditions) {
     if(!groups.has(c.group))errors.push('Unreachable '+i.code+': '+c.group);
     if(!Number.isFinite(c.score)||c.occurrences!==undefined&&(!Number.isInteger(c.occurrences)||c.occurrences<1)||c.proximity!==undefined&&(!Number.isFinite(c.proximity)||c.proximity<0)||c.after&&!groups.has(c.after)||c.near&&!groups.has(c.near))errors.push('Invalid rule '+i.code);
   }
  }
  const ruleCodes=['primary',...(i.alternativeRules??[]).map(r=>r.code)];
  if(new Set(ruleCodes).size!==ruleCodes.length)errors.push('Duplicate rule code '+i.code);
 }
 for(const t of dictionary.transitions) if(!codes.has(t.intent)||!codes.has(t.previousIntent)||!groups.has(t.group)||t.states.some(s=>!states.includes(s))) errors.push('Invalid transition '+JSON.stringify(t));
 for(const p of dictionary.patterns) if(!codes.has(p.intent)||p.groups.some(g=>!groups.has(g))) errors.push('Invalid pattern '+p.intent);
 for(const [a,b] of dictionary.conflicts) if(!codes.has(a)||!codes.has(b)||a===b)errors.push('Invalid conflict '+a+':'+b);
 for(const [term,set] of owners) if(set.size>1)diagnostics.push('Shared term '+term+': '+[...set].join(', '));
 for(const i of dictionary.intents){
  if(i.states.some(s=>!states.includes(s)))errors.push('Invalid intent state '+i.code);
  for(const conditions of [i.conditions,...(i.alternativeRules??[]).map(r=>r.conditions)])for(const c of conditions)if(c.kind==='REQUIRED'&&conditions.some(x=>x.group===c.group&&x.kind==='DISQUALIFY'))errors.push('Contradictory conditions '+i.code);
 }
 const patternsByIntent=new Map<string,Dictionary['patterns']>();
 for(const p of dictionary.patterns){const bucket=patternsByIntent.get(p.intent)??[];bucket.push(p);patternsByIntent.set(p.intent,bucket);}
 const frameCodes=new Set<string>();
 for(const f of dictionary.actionFrames??[]){if(frameCodes.has(f.code)||!codes.has(f.intent)||!f.actions.length||!f.targets.length||!f.prepositions.length||f.sources!==undefined&&(!Array.isArray(f.sources)||f.sources.some(s=>typeof s!=='string'||!s.trim()||f.targets.includes(s))))errors.push('Invalid action frame '+f.code);frameCodes.add(f.code);}
 if(semantic){
  const entityCodes=new Set(semantic.entityTypes??dictionary.entity_terms.map(e=>e.type));
  const industryCodes=new Set(semantic.industryPacks??dictionary.entity_terms.map(e=>e.industry));
  const slots=new Set<string>();
  for(const s of semantic.intentSlots){const key=`${s.intent}:${s.code}:${s.version}`;if(!codes.has(s.intent)||slots.has(key)||!s.code||!['TEXT','NUMBER','MONEY','DATE','TIME','BOOLEAN','ENTITY','ENUM','OBJECT'].includes(s.valueType)||!['REQUIRED','OPTIONAL','CONTEXTUAL','DERIVED'].includes(s.requirement)||!['EXTRACT','REFERENCE','COMMERCE_LOOKUP','DEFAULT','ASK_USER'].includes(s.resolutionStrategy)||!Number.isInteger(s.minCount)||s.minCount<0||s.maxCount!==null&&(!Number.isInteger(s.maxCount)||s.maxCount<s.minCount)||!Number.isInteger(s.clarificationRank)||s.clarificationRank<0||s.entityType&&!entityCodes.has(s.entityType)||!Number.isInteger(s.version)||s.version<1)errors.push('Invalid intent slot '+key);slots.add(key);}
  for(const r of semantic.semanticRelationships){if(!groups.has(r.source)||!groups.has(r.target)||r.source===r.target||!r.relation||!Number.isFinite(Number(r.weight))||Number(r.weight)<0||r.industry&&!industryCodes.has(r.industry)||!Number.isInteger(r.version)||r.version<1)errors.push('Invalid semantic relationship '+r.source+':'+r.relation+':'+r.target);}
  const compositionCodes=new Set<string>(),compositionOutputs=new Map<string,string>();
  for(const r of semantic.compositionRules){
   const key=`${r.leftKind}|${r.relation}|${r.rightKind}`,signature=`${r.code}:${r.version}`,output=JSON.stringify([r.outputKind,r.outputTemplate]);
   if(compositionCodes.has(signature)||!r.code||!r.leftKind||!r.relation||!r.rightKind||!r.outputKind||!r.outputTemplate||!Number.isInteger(r.precedence)||!Number.isFinite(Number(r.score))||r.score<0||r.industry&&!industryCodes.has(r.industry)||!Number.isInteger(r.version)||r.version<1)errors.push('Invalid composition rule '+r.code);
   const previous=compositionOutputs.get(`${key}|${r.precedence}`);if(previous&&previous!==output)errors.push('Conflicting composition rules '+r.code+' at precedence '+r.precedence);
   compositionOutputs.set(`${key}|${r.precedence}`,output);compositionCodes.add(signature);
  }
  const frames=new Set((dictionary.actionFrames??[]).map(f=>f.code));
  for(const s of semantic.actionFrameSlots){if(!frames.has(s.frame)||!['ACTOR','ACTION','OBJECT','QUANTITY','SOURCE','DESTINATION','DATE','TIME','SELECTION','CONSTRAINT'].includes(s.role)||!['REQUIRED','OPTIONAL','CONTEXTUAL','DERIVED'].includes(s.requirement)||!['ZERO_OR_ONE','ONE','ZERO_OR_MORE','ONE_OR_MORE'].includes(s.cardinality)||(!s.semanticGroup&&!s.entityType)||s.semanticGroup&&!groups.has(s.semanticGroup)||s.entityType&&!entityCodes.has(s.entityType)||!Number.isInteger(s.version)||s.version<1)errors.push('Invalid action-frame slot '+s.frame+':'+s.role);}
  for(const a of semantic.ambiguities){const candidates=a.candidateKind==='INTENT'?codes:a.candidateKind==='SEMANTIC_GROUP'?new Set(groups.keys()):a.candidateKind==='ENTITY_TYPE'?entityCodes:new Set<string>();const entityRef=a.candidateRef.split(':');const entityValue=a.candidateKind!=='ENTITY_VALUE'||entityRef.length===2&&entityCodes.has(entityRef[0]!)&&!!entityRef[1];if(!a.term||!a.candidateRef||!['INTENT','SEMANTIC_GROUP','ENTITY_TYPE','ENTITY_VALUE','OPERATOR','ACTION_FRAME'].includes(a.candidateKind)||['INTENT','SEMANTIC_GROUP','ENTITY_TYPE'].includes(a.candidateKind)&&!candidates.has(a.candidateRef)||!entityValue||!Number.isFinite(Number(a.priorWeight))||Number(a.priorWeight)<0||!['SCORE','ASK','PREFER_CONTEXT','PREFER_INDUSTRY'].includes(a.disambiguationPolicy)||a.industry&&!industryCodes.has(a.industry)||!Number.isInteger(a.version)||a.version<1)errors.push('Invalid semantic ambiguity '+a.term);}
  const referenceCodes=new Set<string>();
  for(const r of semantic.referenceRules){const key=`${r.code}:${r.version}`;if(referenceCodes.has(key)||!r.code||!groups.has(r.referenceGroup)||!['ENTITY','ACTION','RESULT_SET','LOCATION','ORDER','ADDRESS'].includes(r.targetKind)||!['LATEST_COMPATIBLE','LATEST_SINGULAR','LATEST_PLURAL','PREVIOUS_SELECTION','SAVED_REFERENCE','ASK'].includes(r.selectionStrategy)||!Number.isInteger(r.precedence)||!Number.isInteger(r.version)||r.version<1)errors.push('Invalid reference rule '+r.code);referenceCodes.add(key);}
  for(const p of semantic.clarificationPolicies){if(!codes.has(p.intent)||!p.slotCode||!p.questionTemplate.trim()||!['NONE','ENGINE','COMMERCE','CONTEXT'].includes(p.candidateMode)||!Number.isInteger(p.maxAttempts)||p.maxAttempts<1||!Number.isInteger(p.priority)||p.priority<0||!Number.isInteger(p.version)||p.version<1)errors.push('Invalid clarification policy '+p.intent+':'+p.slotCode);}
  for(const c of semantic.confidenceCalibrations){if(!['GLOBAL','INTENT_FAMILY','INTENT'].includes(c.scopeKind)||!c.scopeCode||c.scopeKind==='INTENT'&&!codes.has(c.scopeCode)||c.scopeKind==='INTENT_FAMILY'&&!dictionary.intents.some(i=>i.family===c.scopeCode)||!Number.isInteger(c.dictionaryVersion)||c.dictionaryVersion<1||!['IDENTITY','PLATT','ISOTONIC','TEMPERATURE','CUSTOM'].includes(c.method)||!Number.isInteger(c.sampleCount)||c.sampleCount<0)errors.push('Invalid confidence calibration '+c.scopeKind+':'+c.scopeCode);}
  const parents=new Map<string,string[]>();const packSet=new Set<string>(industryCodes);
  for(const relation of semantic.industryPackRelations){if(!packSet.has(relation.parent)||!packSet.has(relation.child)||relation.parent===relation.child)errors.push('Invalid industry pack relation '+relation.parent+':'+relation.child);const children=parents.get(relation.parent)??[];children.push(relation.child);parents.set(relation.parent,children);}
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(code:string)=>{if(visiting.has(code)){errors.push('Industry pack inheritance cycle '+code);return;}if(visited.has(code))return;visiting.add(code);for(const child of parents.get(code)??[])visit(child);visiting.delete(code);visited.add(code);};
  for(const code of packSet)visit(code);
 }
 if(errors.length)throw new Error(errors.join('\n'));
 const compositionBySignature=new Map<string,SemanticCompositionRule[]>();
 for(const rule of [...semantic?.compositionRules??[]].sort((a,b)=>a.precedence-b.precedence||a.code.localeCompare(b.code))){const key=`${rule.leftKind}|${rule.relation}|${rule.rightKind}`,bucket=compositionBySignature.get(key)??[];bucket.push(rule);compositionBySignature.set(key,bucket);}
 const groupTerms=new Map(dictionary.groups.map(group=>[group.code,group.terms]));
 const referenceByExpression=new Map<string,ReferenceRule[]>();
 for(const rule of semantic?.referenceRules??[])for(const phrase of groupTerms.get(rule.referenceGroup)??[]){const key=normalize(phrase),bucket=referenceByExpression.get(key)??[];bucket.push(rule);referenceByExpression.set(key,bucket);}
 for(const bucket of referenceByExpression.values())bucket.sort((a,b)=>a.precedence-b.precedence||a.code.localeCompare(b.code));
 const ambiguitiesByTerm=new Map<string,SemanticAmbiguity[]>();
 for(const ambiguity of semantic?.ambiguities??[]){const key=normalize(ambiguity.term),bucket=ambiguitiesByTerm.get(key)??[];bucket.push(ambiguity);ambiguitiesByTerm.set(key,bucket);}
 const languageKnowledge=dictionary.languageKnowledge?compileKnowledge(dictionary.languageKnowledge):undefined;
 if(dictionary.languageKnowledge&&languageKnowledge)validateRuleExamples(dictionary.languageKnowledge,languageKnowledge);
 return {recognition,...(languageKnowledge?{languageKnowledge}:{}),dictionary,schemaVersion:dictionary.schemaVersion??1,index,diagnostics,patternsByIntent,compositionBySignature,referenceByExpression,ambiguitiesByTerm};
}
