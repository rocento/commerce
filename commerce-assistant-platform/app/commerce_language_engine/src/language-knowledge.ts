import {languagePattern} from './recognition-rules.ts';
/** Declarative, contextual vocabulary. It never grants an intent or an action by itself. */
import {createHash} from 'node:crypto';
import {normalize} from './normalize.ts';
import {validateBudgetRules,type BudgetRule} from './budget-rules.ts';
import {validateRuleGovernance,type GovernedRule} from './rule-governance.ts';
export type KnowledgeKind='color'|'country'|'person'|'activity'|'occasion'|'device'|'material'|'product'|'unit'|'dimension';
export type KnowledgeRelation='intended_use'|'recipient'|'audience'|'occasion'|'color'|'origin_country'|'destination_country'|'market_country'|'compatibility_target'|'material';
export type KnowledgeConcept={id:string;kind:KnowledgeKind;canonical:string;aliases:string[];metadata?:Record<string,unknown>};
export type KnowledgeRule={id:string;marker:string;targetKind:KnowledgeKind;relation:KnowledgeRelation;scope:'product'|'delivery';priority:number;targetMetadata?:Record<string,string|boolean|number>;negated?:true;requiresClarification?:true;targetPossessive?:true;clarifyAlternatives?:true};
export const responsePreferences=['short','explain_fit','tradeoffs','uncertainty','no_assumptions','practical_start','two_options','one_question'] as const;
export type ResponsePreference=typeof responsePreferences[number];
export type UtteranceRule={id:string;role:'background'|'search_prompt'|'response_preference'|'budget_update'|'recommendation_followup'|'lead_in';phrases:string[];preference?:ResponsePreference;reference?:'FIRST'};
// These rules describe complete read questions. They cannot authorize writes.
export const questionIntents=['PRODUCT_SEARCH','PRODUCT_DETAILS','CHECK_PRICE','CHECK_STOCK','PRODUCT_COMPARE','PRODUCT_COMPATIBILITY','PRODUCT_WARRANTY','PRODUCT_MATERIAL','PRODUCT_INGREDIENTS','PRODUCT_ALLERGENS','PRODUCT_ORIGIN','PRODUCT_STORAGE','PRODUCT_CERTIFICATION','PRODUCT_BATTERY_LIFE','PRODUCT_SIZE_GUIDE','RETURN_POLICY','DELIVERY_DATE'] as const;
export type QuestionRule={id:string;intent:typeof questionIntents[number];templates:string[]};
/** Shared full-sentence normalization; courtesies do not change a sentence's role. */
export function utterancePhrase(text:string):string{return normalize(text).replace(languagePattern('language-knowledge.utterancePrefix.pattern.1'),'').replace(languagePattern('language-knowledge.utteranceSuffix.pattern.1'),'');}
export type LanguageKnowledgePack={schemaVersion:1;id:string;revision:number;language:'en';source:string;concepts:KnowledgeConcept[];rules:KnowledgeRule[];utteranceRules?:UtteranceRule[];questionRules?:QuestionRule[];budgetRules?:BudgetRule[];ruleGovernance?:GovernedRule[]};
export type KnowledgeIndex={byFirstToken:Map<string,{concept:KnowledgeConcept;tokens:string[]}[]>;rules:KnowledgeRule[];utteranceRules:UtteranceRule[];budgetRules?:BudgetRule[]};
export type KnowledgeToken={value:string;start:number;end:number};
/** One tokenizer for indexed phrases and source text, preserving possessives and in-word hyphens. */
export function knowledgeTokenSpans(text:string):KnowledgeToken[]{
 return [...text.matchAll(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu)].flatMap(match=>
  normalize(match[0]).split(' ').filter(Boolean).map(value=>({value,start:match.index!,end:match.index!+match[0].length})),
 );
}
export function knowledgeTokens(text:string):string[]{return knowledgeTokenSpans(text).map(token=>token.value);}

const kinds:KnowledgeKind[]=['color','country','person','activity','occasion','device','material','product','unit','dimension'];
const relationKinds:Record<KnowledgeRelation,KnowledgeKind>={intended_use:'activity',recipient:'person',audience:'person',occasion:'occasion',color:'color',origin_country:'country',destination_country:'country',market_country:'country',compatibility_target:'device',material:'material'};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(v);
function fields(v:Record<string,unknown>,required:string[],optional:string[]=[]){if(required.some(k=>!(k in v))||Object.keys(v).some(k=>![...required,...optional].includes(k)))throw new Error('Unexpected language knowledge fields');}
function phrase(v:unknown):v is string{return typeof v==='string'&&v.length>0&&v.length<=200&&knowledgeTokens(v).length>0&&knowledgeTokens(v).length<=20&&!/[\u0000-\u001f]/.test(v);}
function jsonData(v:unknown,depth=0):boolean{
 if(depth>8)return false;
 if(v===null||typeof v==='string'||typeof v==='boolean')return true;
 if(typeof v==='number')return Number.isFinite(v);
 if(Array.isArray(v))return v.length<=100&&v.every(x=>jsonData(x,depth+1));
 return record(v)&&Object.keys(v).length<=50&&Object.entries(v).every(([k,x])=>!['__proto__','constructor','prototype'].includes(k)&&jsonData(x,depth+1));
}
export function knowledgeHash(value:unknown):string{
 const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):record(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function parseLanguageKnowledge(input:unknown):LanguageKnowledgePack{
 if(!record(input))throw new Error('Invalid language knowledge pack');
 fields(input,['schemaVersion','id','revision','language','source','concepts','rules'],['utteranceRules','questionRules','budgetRules','ruleGovernance']);
 if(input.schemaVersion!==1||input.language!=='en'||!identifier(input.id)||!Number.isSafeInteger(input.revision)||Number(input.revision)<1||Number(input.revision)>2147483647||typeof input.source!=='string'||!input.source.trim()||input.source.length>2000||!Array.isArray(input.concepts)||!input.concepts.length||input.concepts.length>100000||!Array.isArray(input.rules)||!input.rules.length||input.rules.length>10000)throw new Error('Invalid language knowledge pack header or bounds');
 const ids=new Set<string>(),owners=new Map<string,KnowledgeConcept[]>();
 for(const c of input.concepts){
  if(!record(c))throw new Error('Invalid knowledge concept');fields(c,['id','kind','canonical','aliases'],['metadata']);
  if(!identifier(c.id)||ids.has(c.id)||!kinds.includes(c.kind as KnowledgeKind)||!phrase(c.canonical)||!Array.isArray(c.aliases)||c.aliases.length>100||c.aliases.some(a=>!phrase(a))||c.metadata!==undefined&&(!record(c.metadata)||!jsonData(c.metadata)||JSON.stringify(c.metadata).length>16000))throw new Error('Invalid or duplicate knowledge concept: '+String(c.id));
  ids.add(c.id);
  for(const flag of ['ambiguous','requiresContext','requiresExactModel'])if(c.metadata?.[flag]!==undefined&&typeof c.metadata[flag]!=='boolean')throw new Error('Invalid concept context flag: '+c.id);
  if(c.metadata?.requiresExactModel!==undefined&&c.kind!=='device')throw new Error('Exact model flag requires a device: '+c.id);
  if(c.metadata?.personRole!==undefined&&(!['audience','recipient'].includes(String(c.metadata.personRole))||c.kind!=='person'))throw new Error('Invalid person role: '+c.id);
  if(['material','product','unit','dimension'].includes(String(c.kind))&&!c.metadata?.lexicalReview)throw new Error('Reviewed lexical provenance required: '+c.id);
  if(c.metadata?.lexicalReview!==undefined){
   const review=c.metadata.lexicalReview;
   if(!record(review))throw new Error('Invalid lexical review: '+c.id);
   fields(review,['source','author','reviewer','method','status','reviewedAt','formsSha256','contentSha256']);
   if(['source','author','reviewer'].some(k=>typeof review[k]!=='string'||!review[k].trim())||!['ai_assisted','human'].includes(String(review.method))||review.status!=='reviewed'||typeof review.reviewedAt!=='string'||!Number.isFinite(Date.parse(review.reviewedAt))||review.formsSha256!==knowledgeHash({kind:c.kind,canonical:c.canonical,aliases:[...c.aliases].sort()})||review.contentSha256!==knowledgeHash({...c,aliases:[...c.aliases].sort(),metadata:Object.fromEntries(Object.entries(c.metadata).filter(([key])=>key!=='lexicalReview'))}))throw new Error('Missing or stale lexical review: '+c.id);
   if(!Array.isArray(c.metadata.domains)||!c.metadata.domains.length||c.metadata.domains.some(d=>!['commerce','electronics','grocery','jewelry','pharmacy'].includes(String(d)))||!['explicit_relationship_only','lexical_annotation_only'].includes(String(c.metadata.usage)))throw new Error('Missing lexical scope: '+c.id);
  }
  const surfaces=[c.canonical,...c.aliases].map(surface=>knowledgeTokens(surface).join(' '));
  if(new Set(c.aliases.map(normalize)).size!==c.aliases.length)throw new Error('Duplicate normalized concept aliases: '+c.id);
  for(const surface of new Set(surfaces)){const list=owners.get(surface)??[];list.push(c as KnowledgeConcept);owners.set(surface,list);}
 }
 for(const [surface,concepts] of owners)if(concepts.length>1){
  if(new Set(concepts.map(c=>c.kind)).size!==concepts.length)throw new Error('Duplicate same-kind knowledge meaning: '+surface);
  if(concepts.some(c=>c.metadata?.ambiguous!==true&&!(Array.isArray(c.metadata?.sharedAliases)&&c.metadata.sharedAliases.some(a=>typeof a==='string'&&knowledgeTokens(a).join(' ')===surface))))throw new Error('Unreviewed cross-kind knowledge alias: '+surface);
 }
 const ruleIds=new Set<string>(),signatures=new Set<string>();
 for(const r of input.rules){
  if(!record(r))throw new Error('Invalid knowledge rule');fields(r,['id','marker','targetKind','relation','scope','priority'],['targetMetadata','negated','requiresClarification','targetPossessive','clarifyAlternatives']);
  if(r.targetPossessive!==undefined&&(r.targetPossessive!==true||r.targetKind!=='person'||r.relation!=='recipient')||r.clarifyAlternatives!==undefined&&(r.clarifyAlternatives!==true||r.targetKind!=='person'||!['recipient','audience'].includes(String(r.relation))))throw new Error('Invalid person composition policy');
  if(r.negated!==undefined&&(r.negated!==true||!['color','material'].includes(String(r.relation)))||r.requiresClarification!==undefined&&r.requiresClarification!==true)throw new Error('Invalid rule polarity or clarification policy');
  if(!identifier(r.id)||ruleIds.has(r.id)||!phrase(r.marker)||r.marker!==normalize(r.marker)||r.marker!==knowledgeTokens(r.marker).join(' ')||!kinds.includes(r.targetKind as KnowledgeKind)||relationKinds[r.relation as KnowledgeRelation]!==r.targetKind||!['product','delivery'].includes(String(r.scope))||!Number.isInteger(r.priority)||Number(r.priority)<0||Number(r.priority)>10000||r.targetMetadata!==undefined&&(!record(r.targetMetadata)||!Object.keys(r.targetMetadata).length||Object.keys(r.targetMetadata).length>10||Object.entries(r.targetMetadata).some(([k,v])=>!identifier(k)||!['string','boolean','number'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v))))throw new Error('Invalid knowledge rule: '+String(r.id));
  if(r.scope==='delivery'&&r.relation!=='destination_country'||r.relation==='destination_country'&&r.scope!=='delivery')throw new Error('Invalid rule scope: '+r.id);
  const signature=knowledgeHash([r.marker,r.targetKind,r.scope,r.priority,r.targetMetadata??{}]);
  if(signatures.has(signature))throw new Error('Conflicting knowledge rule at equal priority: '+r.id);
  if(!input.concepts.some(c=>c.kind===r.targetKind&&Object.entries(r.targetMetadata??{}).every(([k,v])=>c.metadata?.[k]===v)))throw new Error('Unreachable knowledge rule: '+r.id);
  ruleIds.add(r.id);signatures.add(signature);
 }
 if(input.utteranceRules!==undefined){
  if(!Array.isArray(input.utteranceRules)||input.utteranceRules.length>10000)throw new Error('Invalid utterance rules');
  const utteranceIds=new Set<string>(),utterancePhrases=new Set<string>();
  for(const r of input.utteranceRules){
   if(!record(r))throw new Error('Invalid utterance rule');fields(r,['id','role','phrases'],['preference','reference']);
   if(!identifier(r.id)||utteranceIds.has(r.id)||!['background','search_prompt','response_preference','budget_update','recommendation_followup','lead_in'].includes(String(r.role))||!Array.isArray(r.phrases)||!r.phrases.length||r.phrases.length>200||r.phrases.some(p=>typeof p!=='string'||!p.trim()||p.length>250||/[\u0000-\u001f]/.test(p)))throw new Error('Invalid utterance rule: '+String(r.id));
   if(r.role==='response_preference'?!responsePreferences.includes(r.preference as ResponsePreference):r.preference!==undefined)throw new Error('Invalid utterance preference: '+r.id);
   if(r.role==='recommendation_followup'?r.reference!=='FIRST':r.reference!==undefined)throw new Error('Invalid utterance reference: '+r.id);
   for(const p of r.phrases as string[]){
    if(r.role==='budget_update'?(p.match(/\{amount\}/g)?.length!==1||/[{}]/.test(p.replace('{amount}',''))):/[{}$€£\d]/.test(p))throw new Error('Invalid utterance phrase: '+r.id);
    const key=utterancePhrase(p.replace('{amount}','amountslot'));
    if(!key||utterancePhrases.has(key))throw new Error('Conflicting utterance phrase: '+p);
    utterancePhrases.add(key);
   }
   utteranceIds.add(r.id);
  }
 }
 if(input.questionRules!==undefined){
  if(!Array.isArray(input.questionRules)||input.questionRules.length>1000)throw new Error('Invalid question rules');
  const ids=new Set<string>(),templates=new Set<string>();let templateCount=0;
  for(const rule of input.questionRules){
   if(!record(rule))throw new Error('Invalid question rule');fields(rule,['id','intent','templates']);
   if(!identifier(rule.id)||ids.has(rule.id)||!questionIntents.includes(rule.intent as QuestionRule['intent'])||!Array.isArray(rule.templates)||!rule.templates.length||rule.templates.length>100)throw new Error('Invalid question rule: '+String(rule.id));
   ids.add(rule.id);
   templateCount+=rule.templates.length;if(templateCount>5000)throw new Error('Too many question templates');
   for(const template of rule.templates){
    if(typeof template!=='string'||template.length>350||/[\u0000-\u001f]/.test(template))throw new Error('Invalid question template');
    const slots=[...template.matchAll(/\{([^{}]+)\}/g)].map(m=>m[1]);
    const literal=template.replace(/\{[^{}]+\}/g,'');
    if(!slots.includes('product')||new Set(slots).size!==slots.length||slots.some(s=>!['product','other','quantity','device','date','purpose'].includes(s))||/[{}]/.test(literal)||!/^[a-zA-Z '\u2019,?.!-]+$/.test(literal)||!/[a-zA-Z]/.test(literal)||slots.includes('other')!==(rule.intent==='PRODUCT_COMPARE')||slots.includes('device')!==(rule.intent==='PRODUCT_COMPATIBILITY')||slots.includes('quantity')&&rule.intent!=='CHECK_PRICE'||slots.includes('date')!==(rule.intent==='DELIVERY_DATE')||slots.includes('purpose')&&rule.intent!=='DELIVERY_DATE'||/\}\s*\{/.test(template.replace('{product} {date}','{product} date')))throw new Error('Invalid question slots: '+template);
    const key=utterancePhrase(template.replaceAll('{','slot').replaceAll('}','end'));
    if(templates.has(key))throw new Error('Duplicate question template: '+template);templates.add(key);
   }
  }
 }
 if(input.budgetRules!==undefined)validateBudgetRules(input.budgetRules);
 validateRuleGovernance(input as LanguageKnowledgePack);
 return structuredClone(input) as LanguageKnowledgePack;
}
export function canonicalKnowledge(input:unknown):LanguageKnowledgePack{
 const pack=parseLanguageKnowledge(input);
 if(pack.budgetRules)pack.budgetRules.sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id));
 // Example/template order is review content: preserve it so the signed review remains valid.
 if(pack.ruleGovernance)pack.ruleGovernance.sort((a,b)=>(a.family+':'+a.ruleId).localeCompare(b.family+':'+b.ruleId));
 return {...pack,concepts:pack.concepts.sort((a,b)=>a.id.localeCompare(b.id)).map(c=>({...c,aliases:c.aliases.sort((a,b)=>normalize(a).localeCompare(normalize(b))||a.localeCompare(b))})),rules:pack.rules.sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id)),...(pack.utteranceRules?{utteranceRules:pack.utteranceRules.sort((a,b)=>a.id.localeCompare(b.id)).map(r=>pack.ruleGovernance?r:({...r,phrases:r.phrases.sort()}))}:{}),...(pack.questionRules?{questionRules:pack.questionRules.sort((a,b)=>a.id.localeCompare(b.id)).map(r=>pack.ruleGovernance?r:({...r,templates:r.templates.sort()}))}:{})};
}
export function compileKnowledge(input:unknown):KnowledgeIndex{
 const pack=canonicalKnowledge(input),byFirstToken:KnowledgeIndex['byFirstToken']=new Map();
 for(const concept of pack.concepts)for(const surface of new Set([concept.canonical,...concept.aliases].map(phrase=>knowledgeTokens(phrase).join(' ')))){const tokens=surface.split(' '),bucket=byFirstToken.get(tokens[0]!)??[];bucket.push({concept,tokens});byFirstToken.set(tokens[0]!,bucket);}
 for(const bucket of byFirstToken.values())bucket.sort((a,b)=>b.tokens.length-a.tokens.length||a.concept.id.localeCompare(b.concept.id));
 return {byFirstToken,rules:pack.rules,utteranceRules:pack.utteranceRules??[],...(pack.budgetRules?{budgetRules:pack.budgetRules}:{})};
}
