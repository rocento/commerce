import {languageValue} from './recognition-rules.ts';
/** Governance travels inside the hashed release; a review cannot refer to different content. */
import {knowledgeHash,type LanguageKnowledgePack} from './language-knowledge.ts';
export const knowledgeExecutor='knowledge-governance-v1';
export const compositionExecutor='knowledge-composition-v2';
export const compositionPolicyExecutor='knowledge-composition-v3';
export const deliveryQuestionExecutor='knowledge-delivery-questions-v4';
export type RuleFamily='relationship'|'utterance'|'question'|'budget';
export type GovernedRule={family:RuleFamily;ruleId:string;version:number;language:'en';domain:'commerce';runtime:string;definitionSha256:string;contract:Record<string,unknown>;examples:string[];counterexamples:string[];conflictsWith:string[];source:string;author:string;changeReason:string;status:'draft'|'reviewed';review?:{reviewer:string;method:'human'|'ai_assisted';reviewedAt:string;contentSha256:string}};
export function ruleDefinitions(pack:LanguageKnowledgePack){
 return [
  ...pack.rules.map(rule=>({family:'relationship' as const,rule})),
  ...(pack.utteranceRules??[]).map(rule=>({family:'utterance' as const,rule})),
  ...(pack.questionRules??[]).map(rule=>({family:'question' as const,rule})),
  ...(pack.budgetRules??[]).map(rule=>({family:'budget' as const,rule})),
 ];
}
export function ruleContract(family:RuleFamily,rule:any):Record<string,unknown>{
 const common={conflictPolicy:'reject_or_clarify',scope:'product',context:'explicit_product_read',exclusions:['writes','partial_unconsumed_input','unsafe_scope']};
 if(family==='relationship')return {...common,scope:rule.scope,context:rule.marker.startsWith('who ')?'person_antecedent_in_product_read':'explicit_product_read',slots:{target:rule.targetKind,...(rule.targetPossessive?{targetPossessive:true}:{})},output:{relation:rule.relation,...(rule.negated?{negated:true}:{}),...(rule.requiresClarification?{requiresClarification:true}:{}),...(rule.clarifyAlternatives?{clarifyAlternatives:true}:{})},precedence:rule.priority,exclusions:[...common.exclusions,'unresolved_alias']};
 if(family==='budget')return {...common,slots:rule.output==='price_range'?{min:'MONEY',max:'MONEY'}:{amount:'MONEY'},output:{priceOperator:rule.output==='price_range'?'BETWEEN':'<='},precedence:rule.priority,exclusions:[...common.exclusions,'negated_limit','multiple_limits','conditional_limit','quoted_input']};
 if(family==='question')return {...common,...(rule.intent==='DELIVERY_DATE'?{scope:'delivery',context:'complete_replacement_arrival_question'}:{context:'complete_read_question'}),slots:[...new Set(rule.templates.flatMap((s:string)=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1])))].sort(),output:{intent:rule.intent,...(rule.intent==='DELIVERY_DATE'?{status:'NEEDS_CONTEXT',requiresAvailabilityEvidence:true}:{})},precedence:0};
 return {...common,context:rule.role==='lead_in'?'question_lead_in':rule.role==='recommendation_followup'?'prior_recommendation':rule.role==='budget_update'?'single_product_request_or_prior_search':'complete_sentence_in_product_read',slots:rule.role==='budget_update'?{amount:'MONEY'}:{},output:{role:rule.role,...(rule.preference?{preference:rule.preference}:{}),...(rule.reference?{reference:rule.reference}:{})},precedence:0};
}
export function reviewContentHash(row:Omit<GovernedRule,'review'>|GovernedRule):string{
 const {review:_review,status:_status,...content}=row as GovernedRule;return knowledgeHash(content);
}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max=2000)=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
export function validateRuleGovernance(pack:LanguageKnowledgePack){
 if(pack.budgetRules!==undefined&&!pack.ruleGovernance)throw new Error('Budget rules require governance');
 if(pack.rules.some(r=>r.negated||r.requiresClarification||r.targetPossessive||r.clarifyAlternatives||r.targetKind==='material')&&!pack.ruleGovernance)throw new Error('Composition rules require governance');
 if(pack.questionRules?.some(r=>r.intent==='DELIVERY_DATE')&&!pack.ruleGovernance)throw new Error('Delivery questions require governance');
 if(!pack.ruleGovernance)return; // Immutable pre-governance releases remain loadable for rollback.
 const definitions=ruleDefinitions(pack),rows=pack.ruleGovernance;
 if(!Array.isArray(rows)||rows.length!==definitions.length||rows.length>2000)throw new Error('Governance must cover every rule exactly once (maximum 2000)');
 const index=new Map(definitions.map(({family,rule})=>[family+':'+rule.id,{family,rule}])),seen=new Set<string>();
 for(const row of rows){
  if(!object(row)||Object.keys(row).some(k=>!['family','ruleId','version','language','domain','runtime','definitionSha256','contract','examples','counterexamples','conflictsWith','source','author','changeReason','status','review'].includes(k)))throw new Error('Invalid governance fields');
  const key=row.family+':'+row.ruleId,definition=index.get(key);
  if(!definition||seen.has(key))throw new Error('Invalid or duplicate governance reference: '+key);seen.add(key);
  if(!Number.isSafeInteger(row.version)||row.version<1||row.version>2147483647||row.language!=='en'||row.domain!=='commerce'||![knowledgeExecutor,compositionExecutor,compositionPolicyExecutor,deliveryQuestionExecutor].includes(row.runtime))throw new Error('Invalid rule version, domain or runtime compatibility: '+key);
  if('intent' in definition.rule&&definition.rule.intent==='DELIVERY_DATE'&&row.runtime!==deliveryQuestionExecutor)throw new Error('Delivery question requires v4 runtime: '+key);
  if(('targetPossessive' in definition.rule||'clarifyAlternatives' in definition.rule)&&row.runtime!==compositionPolicyExecutor)throw new Error('Person composition policy requires v3 runtime: '+key);
  if(('negated' in definition.rule||'requiresClarification' in definition.rule||'targetKind' in definition.rule&&definition.rule.targetKind==='material'||'output' in definition.rule&&definition.rule.output==='price_range')&&![compositionExecutor,compositionPolicyExecutor].includes(row.runtime))throw new Error('Composition rule requires v2 runtime or later: '+key);
  if(row.definitionSha256!==knowledgeHash(definition.rule)||knowledgeHash(row.contract)!==knowledgeHash(ruleContract(definition.family,definition.rule)))throw new Error('Governance definition/contract mismatch: '+key);
  for(const name of ['examples','counterexamples'] as const)if(!Array.isArray(row[name])||!row[name].length||row[name].length>20||row[name].some(s=>!text(s,1500))||new Set(row[name]).size!==row[name].length)throw new Error('Invalid rule '+name+': '+key);
  if(row.examples.some(s=>row.counterexamples.includes(s)))throw new Error('Contradictory rule examples: '+key);
  if(!Array.isArray(row.conflictsWith)||row.conflictsWith.length>100||new Set(row.conflictsWith).size!==row.conflictsWith.length||row.conflictsWith.some(id=>row.family!=='question'||id===row.ruleId||!index.has('question:'+id)))throw new Error('Invalid conflict reference: '+key);
  if(!text(row.source)||!text(row.author,200)||!text(row.changeReason)||!['draft','reviewed'].includes(row.status))throw new Error('Missing rule provenance: '+key);
  if(row.status==='draft'&&row.review!==undefined)throw new Error('Draft rule cannot claim a review: '+key);
  if(row.status==='reviewed'){
   const r=row.review;
   if(!object(r)||Object.keys(r).sort().join(',')!=='contentSha256,method,reviewedAt,reviewer'||!text(r.reviewer,200)||!['human','ai_assisted'].includes(r.method)||typeof r.reviewedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.reviewedAt)||!Number.isFinite(Date.parse(r.reviewedAt))||r.contentSha256!==reviewContentHash(row))throw new Error('Missing or stale rule review: '+key);
  }
 }
 // Exact predicates may differ syntactically while accepting the same concept.
 for(let i=0;i<pack.rules.length;i++)for(const b of pack.rules.slice(i+1)){
  const a=pack.rules[i];
  if(a.marker===b.marker&&a.scope===b.scope&&a.targetKind===b.targetKind&&a.priority===b.priority&&pack.concepts.some(c=>c.kind===a.targetKind&&[a,b].every(r=>Object.entries(r.targetMetadata??{}).every(([k,v])=>c.metadata?.[k]===v))))throw new Error('Overlapping relationship precedence: '+a.id+' / '+b.id);
 }
 for(const [a,b] of questionOverlapPairs(pack))if(!rows.find(r=>r.family==='question'&&r.ruleId===a)?.conflictsWith.includes(b)||!rows.find(r=>r.family==='question'&&r.ruleId===b)?.conflictsWith.includes(a))throw new Error('Undeclared overlapping question rules: '+a+' / '+b);
}
/** Conservative bounded intersection of literal tokens and nonempty typed slots. */
export function questionOverlapPairs(pack:LanguageKnowledgePack):[string,string][]{
 const definitions=(pack.questionRules??[]).flatMap(r=>r.templates.map(template=>({id:r.id,template})));
 if(definitions.length>512)throw new Error('Governed question templates exceed complexity budget (512)');
 const devices=[...new Set(pack.concepts.filter(c=>c.kind==='device').flatMap(c=>[c.canonical,...c.aliases]))];
 const frames=definitions.flatMap(row=>{
  const variants=row.template.includes('{device}')?devices.flatMap(device=>languageValue<string[]>('rule-governance.canonical.value.1').map(owner=>row.template.replace('{device}',owner+device))):[row.template];
  return variants.map(template=>({...row,tokens:template.toLowerCase().replace(/[.!?]+$/,'').match(/\{\w+\}|[a-z0-9]+|[^\s]/g)??[]}));
 });
 if(frames.length>2048)throw new Error('Governed question/device expansion exceeds complexity budget (2048)');
 let work=0;
 const forbidden=new Set(languageValue<string[]>('rule-governance.canonical.value.2'));
 const compatible=(a:string,b:string)=>{
  const slot=(s:string)=>s.startsWith('{');
  if(!slot(a)&&!slot(b))return a===b;
  if(slot(a)&&slot(b))return true;
  const s=slot(a)?a:b,literal=slot(a)?b:a;
  return s==='{quantity}'?/^[1-9][0-9]*$/.test(literal):s==='{date}'?['today','tomorrow'].includes(literal):!forbidden.has(literal);
 };
 const overlap=(a:string[],b:string[])=>{
  const queue:[number,number][]=[[0,0]],seen=new Set<string>();
  for(let at=0;at<queue.length;at++){
   if(++work>2000000)throw new Error('Question overlap analysis exceeds complexity budget');
   const [i,j]=queue[at],key=i+':'+j;if(seen.has(key))continue;seen.add(key);
   if(i===a.length&&j===b.length)return true;
   if(i===a.length||j===b.length||!compatible(a[i],b[j]))continue;
   const next=(xs:string[],n:number)=>xs[n].startsWith('{')&&!['{quantity}','{date}'].includes(xs[n])?[n,n+1]:[n+1];
   for(const x of next(a,i))for(const y of next(b,j))queue.push([x,y]);
  }
  return false;
 };
 const pairs=new Map<string,[string,string]>();
 for(let i=0;i<frames.length;i++)for(let j=i+1;j<frames.length;j++){
  if(++work>2000000)throw new Error('Question overlap analysis exceeds complexity budget');
  // Literal first tokens must intersect before allocating pair keys or a BFS.
  // Keep counting every pair so the existing complexity limit is unchanged.
  if(frames[i].id===frames[j].id)continue;
  const a=frames[i].tokens,b=frames[j].tokens;
  if(a.length&&b.length&&!compatible(a[0]!,b[0]!))continue;
  const ids=[frames[i].id,frames[j].id].sort() as [string,string],key=ids.join(':');
  if(ids[0]!==ids[1]&&!pairs.has(key)&&overlap(frames[i].tokens,frames[j].tokens))pairs.set(key,ids);
 }
 return [...pairs.values()];
}
export function assertKnowledgeUpgrade(previous:LanguageKnowledgePack|undefined,next:LanguageKnowledgePack|undefined){
 if(!previous?.ruleGovernance)return;
 if(!next?.ruleGovernance)throw new Error('Governed knowledge cannot be removed or downgraded');
 const prior=new Map(previous.ruleGovernance.map(row=>[row.family+':'+row.ruleId,row]));
 if(previous.id!==next.id||next.revision<previous.revision||next.revision===previous.revision&&knowledgeHash(previous)!==knowledgeHash(next))throw new Error('Changed governed pack requires a new revision');
 for(const row of next.ruleGovernance){const before=prior.get(row.family+':'+row.ruleId);if(before&&(row.version<before.version||row.definitionSha256!==before.definitionSha256&&row.version===before.version))throw new Error('Changed rule requires a new version: '+row.ruleId);}
}
export function assertKnowledgeReviewed(pack:LanguageKnowledgePack|undefined){
 if(pack)validateRuleGovernance(pack);
 if(pack?.ruleGovernance?.some(row=>row.status!=='reviewed'))throw new Error('Publication requires reviewed knowledge rules');
}
