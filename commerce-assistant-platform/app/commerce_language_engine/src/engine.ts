import {withRecognitionRules} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
import {scopedTokenCorrections,correctionProposals,evidence,type CorrectionTrace} from './language-corrections.ts';
import {scopedEntityAliases} from './reference-resolution.ts';
import {actionInterpretationConflicts} from './action-agreement.ts';
import {compoundReply, type CompoundReply} from './compound-clarification.ts';
import {compoundRequest} from './compound-language.ts';
import {countIntents, type IntentCount, type RequestedAction} from './intent-count.ts';
import {recommendationRequest} from './recommendation-language.ts';
import { orderRequestIssue } from './order-product-language.ts';
import {productGuidance, orderProductGuidance, countedProductGuidance} from './product-guidance.ts';
import {wishlistReadOrCommand,preservedWishlistReference} from './wishlist-language.ts';
import {wishlistReadRequested} from './wishlist-read-language.ts';
import {savedCollectionRequested,savedCollectionChoice,savedCollectionQuestion} from './saved-collection-language.ts';
import {pendingClarification,clarificationText,clarificationQuestion} from './clarification-replies.ts';
import {productFactRead} from './product-facts-language.ts';
import {questionRead,questionLeadIn} from './question-language.ts';
import {requestConstraints,constraintQuestion,courtesyCoreText} from './request-constraints.ts';
import {searchUpdate,updatedSearch} from './search-updates.ts';
import {searchAttributes} from './search-attributes.ts';
import {purposeSearch} from './purpose-language.ts';
import {contextualShoppingSearch} from './contextual-language.ts';
import {shoppingUtterance,recommendationReferenceFollowup} from './utterance-language.ts';
import {discourseProductIssue,recommendationProductPhrase} from './discourse-boundary.ts';
import {clearComparisonRequested} from './comparison-language.ts';
import {clearCartRequested} from './cart-clear-language.ts';
import {recommendationFilters} from './recommendation-filters.ts';
import {withoutPriceTail,conflictingPriceBounds} from './price-language.ts';
import {commerceFragment} from './commerce-fragments.ts';
import {conversationIntent} from './conversation.ts';
import {productMeaning,type ProductMeaning} from './product-meaning.ts';
import {unsupportedIntents} from './unsupported.ts';
import {canonicalRead} from './read-language.ts';
import {governedRead,governedRequest} from './governed-read-language.ts';
import {requestEnvelope} from './request-envelope.ts';
import {quotedSearch} from './quoted-search.ts';
import {evidenceRequirements} from './evidence-requirements.ts';
import {quotedNumericProduct} from './quantities.ts';
import {contextualRequest,semanticRequest} from './semantic-request.ts';
import {buildSemanticGraph} from './semantic-graph.ts';
import {transferReply} from './transfer-parser.ts';
import {clauses,hasUnparsedSentenceAction} from './semantic-clauses.ts';
import {responseMessage} from './response-message.ts';
import {collectionContext} from './collection-context.ts';
import {scoringConfig,scoreConfidence,type ScoringOptions} from './scoring.ts';
import {parseRequest,suppressRequestPrefixes,fulfillment} from './request-parser.ts';
import {performance} from 'node:perf_hooks';
import {normalize} from './normalize.ts';
import {directNeedSearch,searchCommandCorrections} from './search-language.ts';
import {productArgument} from './product-argument.ts';
import {extract} from './entities.ts';
import type {Compiled} from './compiler.ts';
import type {Context, Match, Candidate, LanguageStatus} from './types.ts';
import type {SemanticRequest} from './semantic-types.ts';
/** A held action cannot retain links or slots belonging to its discarded graph. */
function discardedActionGraph():Pick<SemanticRequest,'relationships'|'references'|'slots'>&{graph:undefined}{
 return {relationships:[],references:[],slots:[],graph:undefined};
}
function resolveFlat(compiled:Compiled,text:string,context:Context={},options:ScoringOptions={}) {
 const config=scoringConfig(options);
 const literalSearch=quotedSearch(text);
 const start=performance.now();const normalizedText=normalize(text);const rawTokens=normalizedText.split(' ').filter(Boolean);const tokens=[...rawTokens];
 for(const correction of scopedTokenCorrections(text))tokens[correction.tokenIndex]=correction.to;
 const searchCorrections=searchCommandCorrections(text);
 for(const correction of searchCorrections)tokens[correction.tokenIndex]=correction.to;
 const matches:Match[]=[];
 for(let p=0;p<tokens.length;p++) for(const term of compiled.index.get(tokens[p])??[]) {
  if(!term.tokens.every((t,j)=>tokens[p+j]===t))continue;
  const preceding=tokens.slice(Math.max(0,p-7),p); const boundary=Math.max(preceding.lastIndexOf('but'),preceding.lastIndexOf('just'),preceding.lastIndexOf('instead'),preceding.lastIndexOf('then'),preceding.lastIndexOf('however'));
  const negated=term.group.startsWith('ACTION_')&&(preceding.slice(boundary+1).some(t=>languageValue<string[]>('engine.negated.value.1').includes(t))||languageValue<string[]>('engine.negated.value.2').includes(tokens[p])&&tokens[p+term.tokens.length]===languageValue<string>('engine.negated.value.3'));
  matches.push({group:term.group,phrase:rawTokens.slice(p,p+term.tokens.length).join(' '),start:p,end:p+term.tokens.length,negated,fuzzy:term.tokens.some((t,j)=>rawTokens[p+j]!==t)});
 }
 // An explicit category argument owns its words, including names that also
 // occur in action groups (for example New Arrivals). Use the governed whole
 // recommendation grammar; compound actions and unknown requirements are not
 // consumed as category values. Catalog identity is resolved by the store.
 const category= recommendationFilters(withoutPriceTail(text))?.category;
 if(category){
  const words=normalize(category).split(' ');
  const at=tokens.findIndex((_,i)=>words.every((word,j)=>tokens[i+j]===word));
  if(at>=0)for(let i=matches.length-1;i>=0;i--){
   const match=matches[i];
   if(match.group.startsWith('ACTION_')&&match.start>=at&&match.end<=at+words.length)matches.splice(i,1);
  }
 }
 const structuralFrames=literalSearch?[]:parseRequest(tokens,compiled.dictionary);
 const incompleteCollections=structuralFrames.length?[]:collectionContext(tokens,compiled.dictionary,matches);
 const contextualFrames=context.collection?incompleteCollections.filter(f=>f.entities.destination===normalize(context.collection!)):[];
 const activeFrames=[...contextualFrames,...structuralFrames.filter(f=>!f.negated&&!f.excludedObject&&!f.instructional)];
 const transferSpans=structuralFrames.filter(f=>f.entities.sourceCollection);
 const scopedMatches=matches.filter(m=>!m.group.startsWith('ACTION_')||!transferSpans.some(f=>m.start>=f.start+f.action.split(' ').length&&m.end<=f.end));
 const filtered=suppressRequestPrefixes(literalSearch?scopedMatches.filter(m=>m.end<=literalSearch.commandTokens):scopedMatches,tokens,compiled.dictionary);
 const argument=productArgument(tokens,filtered.matches);
 const productActionGroups=new Set(compiled.dictionary.intents.filter(i=>i.productArgument).map(i=>i.conditions[0].group));
 const productArguments=new Map(compiled.dictionary.intents.filter(i=>i.productArgument).map(i=>[i.code,productArgument(tokens,filtered.matches,i.conditions[0].group,productActionGroups)]));
 if(literalSearch)productArguments.set('PRODUCT_SEARCH',{productText:literalSearch.productText});
 // Open noun phrases own their interior words even when a noun happens to be
 // an action or structural object elsewhere (e.g. a contact lens solution).
 // This uses syntax only: adding/removing catalog aliases cannot change scores.
 const nounSpans=[...productArguments.values()].flatMap(a=>{if(!a.productText)return [];const phrase=a.productText.split(' ');const start=tokens.findIndex((_,p)=>phrase.every((word,j)=>tokens[p+j]===word));return start>=0?[{start,end:start+phrase.length}]:[];});
 const nounMatches=filtered.matches.filter(m=>!productActionGroups.has(m.group)&&(m.group.startsWith('ACTION_')||m.group.startsWith('OBJECT_'))&&nounSpans.some(s=>m.start>=s.start&&m.end<=s.end));
 filtered.matches=filtered.matches.filter(m=>!nounMatches.includes(m));
 const present=new Map<string,Match[]>();for(const m of filtered.matches.filter(m=>!m.negated)){const bucket=present.get(m.group)??[];bucket.push(m);present.set(m.group,bucket);}
 const extractionText=literalSearch?literalSearch.command:tokens.join(' ');
 const entities=extract(extractionText,scopedEntityAliases(compiled.dictionary,extractionText,context,compiled.ambiguitiesByTerm));
 const candidates:Candidate[]=[];
 const activeTransitions=compiled.dictionary.transitions.filter(t=>t.previousIntent===context.previousIntent&&present.has(t.group)&&t.states.every(s=>context.states?.includes(s)));
 const genericPhrases=new Set([...(compiled.dictionary.requestPrefixes??[]),languageValue<string>('engine.genericPhrases.value.1'),languageValue<string>('engine.genericPhrases.value.2'),languageValue<string>('engine.genericPhrases.value.3'),languageValue<string>('engine.genericPhrases.value.4'),languageValue<string>('engine.genericPhrases.value.5'),languageValue<string>('engine.genericPhrases.value.6'),languageValue<string>('engine.genericPhrases.value.7'),languageValue<string>('engine.genericPhrases.value.8'),languageValue<string>('engine.genericPhrases.value.9'),languageValue<string>('engine.genericPhrases.value.10'),languageValue<string>('engine.genericPhrases.value.11'),languageValue<string>('engine.genericPhrases.value.12'),languageValue<string>('engine.genericPhrases.value.13')]);
 const searchAction=compiled.dictionary.intents.find(i=>i.code==='PRODUCT_SEARCH')?.conditions[0].group;
 const priceSearch=tokens.includes(languageValue<string>('engine.priceSearch.value.1'))&&!!productArguments.get('PRODUCT_SEARCH')?.productText;
 const explicitProductAction=filtered.matches.some(m=>!m.negated&&m.group!==searchAction&&productActionGroups.has(m.group)&&!genericPhrases.has(m.phrase));
 const generic=(m:Match)=>genericPhrases.has(m.phrase)&&!(m.group===searchAction&&(priceSearch&&languageValue<string[]>('engine.generic.value.1').includes(m.phrase)||!explicitProductAction&&directNeedSearch(tokens,m,productArguments.get('PRODUCT_SEARCH')?.productText??'')));
 const entityGroups=new Set(compiled.dictionary.groups.filter(g=>['ATTRIBUTE','ENTITY'].includes(g.category)).map(g=>g.code));
 const entityGroup=(group:string)=>entityGroups.has(group)||group==='OBJECT_PRODUCT';
 const requestMarker=tokens.some(t=>languageValue<string[]>('engine.requestMarker.value.1').includes(t))||filtered.suppressed.length>0;
 const ordinalSelection=languagePattern('engine.ordinalSelection.pattern.1').test(tokens.join(' '));
 for(const intent of compiled.dictionary.intents) {
  // An explicit cancellation of a duplicate order is still cancellation; the
  // duplicate-report taxonomy shares verbs but cannot change the requested act.
  if(intent.code==='ORDER_DUPLICATE'&&present.has('ACTION_CANCEL'))continue;
  // Browser-state clearing is admitted only by its complete command grammar.
  if(intent.code==='CLEAR_COMPARISON'&&!clearComparisonRequested(text))continue;
 if(compiled.dictionary.actionFrames?.some(f=>f.intent===intent.code&&f.sources?.length)&&!activeFrames.some(f=>f.intent===intent.code))continue;
 for(const rule of [{code:'primary',conditions:intent.conditions,states:[]},...(intent.alternativeRules??[])]) {
  // Explicit tracking owns the read; bare recency must not propose creation/details.
  if(rule.code==='order-recency'&&present.has('ACTION_TRACK'))continue;
  const conditions=rule.conditions.filter(c=>c.active!==false);
  const frame=activeFrames.find(f=>f.intent===intent.code);
  let score=0;const evidence:Candidate['evidence']=[],penalties:Candidate['penalties']=[],missing:string[]=[];
  const used=new Set<number>(),penalized=new Set<number>();
  const requiredMatches:Match[]=[];
  const transition=rule.code==='primary'?activeTransitions.find(t=>t.intent===intent.code&&(!['SELECT_PRODUCT','SELECT_ORDER'].includes(t.intent)||tokens.every(token=>languageValue<string[]>('engine.transition.value.1').includes(token))||t.intent==='SELECT_PRODUCT'&&ordinalSelection)):undefined;
  const add=(group:string,kind:string,value:number)=>{score+=value;(value<0?penalties:evidence).push({group,kind,score:value});};
  const claim=(m:Match,seen:Set<number>)=>{if(Array.from({length:m.end-m.start},(_,i)=>m.start+i).some(p=>seen.has(p)))return false;for(let p=m.start;p<m.end;p++)seen.add(p);return true;};
  for(const c of [...conditions].sort((a,b)=>Number(b.kind==='REQUIRED')-Number(a.kind==='REQUIRED'))) {
   const negative=c.kind==='NEGATIVE'||c.kind==='DISQUALIFY';
   if(entityGroup(c.group)&&!negative)continue;
   let occurrences=(present.get(c.group)??[]).filter(m=>negative||!generic(m)&&!entityGroup(c.group));
   // A structural noun phrase owns its span: 'refund timeline' is not a bare refund object.
   if(!negative&&c.group.startsWith('OBJECT_'))occurrences=occurrences.filter(m=>!filtered.matches.some(other=>!other.group.startsWith('ACTION_')&&!entityGroup(other.group)&&!(intent.code==='CANCEL_ORDER'&&other.group==='OBJECT_DUPLICATE_ORDER')&&other.start<=m.start&&other.end>=m.end&&other.end-other.start>m.end-m.start&&(
    // A recency composition still applies to a bare fragment such as 'latest
    // order'. Tracking a latest order also retains its order noun unless a
    // complete competing command gives the longer history phrase ownership.
    (rule.code!=='order-recency'&&!(intent.code==='TRACK_ORDER'&&entities.orderSelection==='LATEST'))||compiled.dictionary.intents.some(owner=>owner.conditions.some(condition=>condition.kind==='REQUIRED'&&condition.group===other.group)&&owner.conditions.some(condition=>condition.kind==='REQUIRED'&&condition.group.startsWith('ACTION_')&&present.has(condition.group)))
   )));
   if(c.kind==='REQUIRED'&&matches.some(m=>m.group===c.group&&m.negated&&(!frame||m.start>=frame.start&&m.end<=frame.end)&&claim(m,penalized)))add(c.group,'NEGATED_REQUIRED_ACTION',-config.penalties.negatedAction);
   if(c.after)occurrences=occurrences.filter(m=>(present.get(c.after!)??[]).some(before=>before.end<=m.start&&(c.proximity===undefined||m.start-before.end<=c.proximity)));
   if(c.near)occurrences=occurrences.filter(m=>(present.get(c.near!)??[]).some(anchor=>Math.max(0,m.start-anchor.end,anchor.start-m.end)<=(c.proximity??12)));
   if(c.proximity!==undefined&&!c.after&&!c.near)occurrences=occurrences.filter(m=>matches.some(other=>other.group!==m.group&&!other.negated&&Math.abs(m.start-other.start)<=c.proximity!));
   const distinct:Match[]=[];
   for(const m of occurrences.sort((a,b)=>(b.end-b.start)-(a.end-a.start)))if(!distinct.some(o=>m.start<o.end&&o.start<m.end))distinct.push(m);
   const hit=distinct.length>=(c.occurrences??1);
   if(c.kind==='NEGATIVE'||c.kind==='DISQUALIFY') {
    if(hit&&distinct.some(m=>claim(m,penalized)))add(c.group,'CONTRADICTION',-config.penalties.contradiction);
    continue;
   }
   if(c.kind==='REQUIRED') {
    if(!hit){if(!missing.includes(c.group))missing.push(c.group);continue;}
    requiredMatches.push(...distinct);
   }
   if(hit&&distinct.some(m=>claim(m,used)))add(c.group,c.kind,c.kind==='REQUIRED'?config.weights.required:config.weights.optional);
  }
  let contextBoost=0;
  // An indirect rule cannot turn an explicitly denied command into an event
  // report. A later affirmative command in that action group may still proceed.
  if(rule.code!=='primary'&&!present.has(intent.conditions[0].group)&&matches.some(m=>m.group===intent.conditions[0].group&&m.negated))add(intent.conditions[0].group,'NEGATED_REQUIRED_ACTION',-config.penalties.negatedAction);
  // Frames supply the same action/object evidence as semantic rules, never a fixed override score.
  if(frame&&rule.code==='primary') {
   for(const group of conditions.filter(c=>c.kind==='REQUIRED').slice(0,2).filter(c=>(c.occurrences??1)===1&&!c.after&&!c.near&&c.proximity===undefined).map(c=>c.group)) {
    if(missing.includes(group)){
     missing.splice(missing.indexOf(group),1);
     if(frame.contextual&&group.startsWith('OBJECT_')){contextBoost=config.weights.context;add('collection','CONTEXT',contextBoost);}
     else add(group,'REQUIRED',config.weights.required);
    }
   }
  }
  if(transition&&['SELECT_PRODUCT','SELECT_ORDER','REORDER'].includes(intent.code)&&missing.includes(conditions[0]?.group)) {
   const reference=present.get(transition.group)?.[0];
   if(reference&&claim(reference,used)){missing.splice(missing.indexOf(conditions[0].group),1);requiredMatches.push(reference);add(transition.group,'REQUIRED',config.weights.required);}
  }
  if(transition&&(!missing.includes(conditions[0]?.group)||['SELECT_PRODUCT','SELECT_ORDER','REORDER'].includes(intent.code))) {
   // Context binds an implicit object. Its evidence is a bounded boost, not fabricated word matches.
   for(let i=missing.length-1;i>=0;i--)if(missing[i]!==conditions[0]?.group)missing.splice(i,1);
   contextBoost=config.weights.context;add(transition.group,'CONTEXT',contextBoost);
  }
  for(const group of missing)add(group,'MISSING_REQUIRED_INTENT_SIGNAL',-config.penalties.missingRequired);
  // A concrete direct object is syntactic intent evidence even when the catalog
  // has never seen its name. Attributes and catalog matches supply no score.
  const concreteArgument=intent.productArgument&&requiredMatches.length>0&&!!productArguments.get(intent.code)?.productText&&!languagePattern('engine.concreteArgument.pattern.1').test(productArguments.get(intent.code)!.productText);
  if(rule.code==='primary'&&concreteArgument&&!missing.length)add('PRODUCT_ARGUMENT','REQUIRED',config.weights.required);
  const relation=frame&&rule.code==='primary'||requiredMatches.some(a=>requiredMatches.some(b=>a.group!==b.group&&a.end<=b.start&&b.start-a.end<=12))||
   concreteArgument||transition&&contextBoost>0&&requiredMatches.length>0;
  if(relation&&!missing.length&&!conditions.some(c=>c.kind==='DISQUALIFY'&&penalties.some(p=>p.group===c.group)))add(frame?.code??requiredMatches.map(m=>m.group).filter((g,i,a)=>a.indexOf(g)===i).join('+'),'RELATIONSHIP',config.weights.relationship);
  const competingFrame=activeFrames.find(f=>f.intent!==intent.code&&requiredMatches.some(m=>m.start===f.start)&&compiled.dictionary.actionFrames?.some(schema=>schema.intent===intent.code));
  if(competingFrame&&!frame)add(competingFrame.code,'CONTRADICTORY_DESTINATION',-config.penalties.contradiction);
  if(requestMarker)add('REQUEST_MARKER','GENERIC',config.weights.generic);
  // Conversation-only rules still require a whole utterance, not a word inside another request.
  if(intent.family==='Conversation'&&!transition&&conditions.length===1&&!requiredMatches.some(m=>tokens.filter((t,p)=>p<m.start||p>=m.end).every(t=>languageValue<string[]>('engine.resolveFlat.value.1').includes(t))))continue;
  if(!evidence.some(e=>e.kind!=='GENERIC')&&!penalties.some(p=>p.kind!=='MISSING_REQUIRED_INTENT_SIGNAL'))continue;
  candidates.push({intent:intent.code,rule:rule.code,score,evidence,penalties,contextBoost,missing});
 }
 }
 const rejected=new Set(structuralFrames.filter(f=>f.excludedObject||f.instructional).map(f=>f.intent));
 if(present.has('NON_COMMERCE_REQUEST')||structuralFrames.some(f=>f.instructional)&&!activeFrames.length)for(const candidate of candidates)rejected.add(candidate.intent);
 for(let i=candidates.length-1;i>=0;i--)if(rejected.has(candidates[i].intent)&&!activeFrames.some(f=>f.intent===candidates[i].intent))candidates.splice(i,1);
 const bestByIntent=new Map<string,Candidate>();
 for(const candidate of candidates){const previous=bestByIntent.get(candidate.intent);if(!previous||candidate.score>previous.score)bestByIntent.set(candidate.intent,candidate);}
 candidates.splice(0,candidates.length,...bestByIntent.values());
 candidates.sort((a,b)=>b.score-a.score||a.intent.localeCompare(b.intent));
 const explicitIntents=new Set(activeFrames.map(f=>f.intent));
 if(activeFrames.length){for(const candidate of candidates){if(explicitIntents.has(candidate.intent))continue;const definition=compiled.dictionary.intents.find(i=>i.code===candidate.intent)!;const commandMatches=present.get(definition.conditions[0].group)??[];if(commandMatches.some(m=>!(compiled.dictionary.requestPrefixes??[]).includes(m.phrase)&&activeFrames.every(f=>m.end<=f.start||m.start>=f.end)))explicitIntents.add(candidate.intent);}}
 for(const [a,b] of compiled.dictionary.conflicts){
  const first=compiled.dictionary.intents.find(i=>i.code===a)!,second=compiled.dictionary.intents.find(i=>i.code===b)!;
  const object=first.conditions[1]?.group;
  if(!object||object!==second.conditions[1]?.group||!present.has(object))continue;
  const left=present.get(first.conditions[0].group)??[],right=present.get(second.conditions[0].group)??[];
  if(left.some(x=>right.some(y=>x.end<=y.start&&tokens.slice(x.end,y.start).some(t=>languageValue<string[]>('engine.resolveFlat.value.2').includes(t))||y.end<=x.start&&tokens.slice(y.end,x.start).some(t=>languageValue<string[]>('engine.resolveFlat.value.3').includes(t))))){explicitIntents.add(a);explicitIntents.add(b);}
 }
 const compoundRequest=explicitIntents.size>1||activeFrames.filter(f=>f.entities.sourceCollection).length>1;
 const winner=candidates[0];
 const metrics=scoreConfidence(candidates,config);
 let status:LanguageStatus='UNKNOWN';const confidence=metrics.confidence;let intent:string|null=null;
 if(winner&&winner.score>=config.minScore) {
  status=metrics.scoreMargin<config.minScoreMargin||metrics.probabilityMargin<config.minProbabilityMargin||confidence<config.minConfidence||compoundRequest?'AMBIGUOUS':'RESOLVED';
  if(status==='RESOLVED')intent=winner.intent;
 }
 const resolvedFrame=activeFrames.find(f=>f.intent===intent);
 if(resolvedFrame){Object.assign(entities,resolvedFrame.entities);if(resolvedFrame.entities.line_items)for(const key of languageValue<string[]>('engine.resolveFlat.value.4'))delete entities[key];}
 if(resolvedFrame?.entities.sourceCollection&&entities.product_reference&&context.collection===entities.sourceCollection&&context.selectedItems?.length===1){
  resolvedFrame.description=context.selectedItems[0].productText!;delete entities.product_reference;
 }
 const fulfillmentResult=fulfillment(intent,resolvedFrame,entities);
 const winningFrame=resolvedFrame;
 if(winningFrame){if(winningFrame.description&&!winningFrame.entities.line_items)entities.productText=winningFrame.description;}
 else if(compiled.dictionary.intents.find(i=>i.code===(intent??winner?.intent))?.productArgument&&(argument.productText||literalSearch))Object.assign(entities,productArguments.get(intent??winner?.intent??'')??argument);
 if(intent==='PRODUCT_SEARCH'&&tokens.includes(languageValue<string>('engine.resolveFlat.value.5')))entities.sort_by='price_asc';
 const definition=compiled.dictionary.intents.find(i=>i.code===intent);
 if(intent==='REORDER'&&entities.product_reference){delete entities.product_reference;entities.orderSelection='CURRENT';}
 if(intent==='REORDER'&&winner?.contextBoost&&!entities.orderSelection&&!entities.order_reference)entities.orderSelection='CURRENT';
 const missing:string[]=[];
 if(intent){
  if(fulfillmentResult?.needsClarification)missing.push(...(fulfillmentResult.quantityClarification?languageValue<string[]>('engine.resolveFlat.value.6'):[]),...(fulfillmentResult.unresolvedSlots.some(s=>s.reason==='PRODUCT_SELECTION_REQUIRED')?['productReference']:[]));
  if(entities.product_reference&&(entities.sourceCollection||!context.states?.includes('PRODUCT_SELECTED')))missing.push('productReference');
  if(entities.orderSelection==='CURRENT'&&!context.states?.includes('ORDER_SELECTED'))missing.push('orderReference');
  if(definition?.productArgument&&!productArguments.get(definition.code)?.productText)missing.push('productReference');
  const selectionRequired=compiled.dictionary.actionFrames?.some(f=>f.intent===intent&&f.selectionRequired)||['ADD_TO_CART','REMOVE_FROM_CART','ADD_TO_WISHLIST','REMOVE_FROM_WISHLIST'].includes(intent);
  if(selectionRequired&&!resolvedFrame&&!context.states?.some(s=>['PRODUCT_SELECTED','CART_NON_EMPTY'].includes(s))&&(!argument.productText||languagePattern('engine.resolveFlat.pattern.1').test(argument.productText.replace(languagePattern('engine.resolveFlat.pattern.2'),''))))missing.push('productReference');
  for(const key of definition?.requiredEntities??[])if(entities[key]===undefined)missing.push(key);
  const ruleStates=definition?.alternativeRules?.find(r=>r.code===winner?.rule)?.states??[];
  if(definition?.states.length&&!definition.states.some(s=>context.states?.includes(s))||!ruleStates.every(s=>context.states?.includes(s)))missing.push('context');
  // A generic cart removal can resolve by presenting the customer's cart items.
  // The action service still requires an exact item and explicit confirmation to write.
  if(intent==='REMOVE_FROM_CART'&&!compoundRequest&&missing.length&&missing.every(slot=>slot==='productReference')&&(!entities.productText||languagePattern('engine.resolveFlat.pattern.3').test(String(entities.productText)))){
   missing.length=0;
   delete entities.productText;
   delete entities.product_reference;
  }
  if(missing.length)status='NEEDS_CONTEXT';
 }
 const contextRequest=!intent&&!compoundRequest&&status==='UNKNOWN'&&incompleteCollections.length?{
  field:'collection',question:'Which collection do you mean?',
  options:[...new Set(incompleteCollections.map(f=>String(f.entities.destination)))],
  possibleIntents:[...new Set(incompleteCollections.map(f=>f.intent))],
 }:undefined;
 if(contextRequest){status='NEEDS_CONTEXT';missing.push('collection');}
 const nextContext=status==='RESOLVED'?advanceContext(context,intent):{...context};
 const message=responseMessage({status,text,intent,missing,collections:contextRequest?.options,states:[...definition?.states??[],...definition?.alternativeRules?.find(r=>r.code===winner?.rule)?.states??[]],compoundRequest,requiresConfirmation:definition?.requiresConfirmation??false});
 return {status,message,...(contextRequest?{contextRequest}:{}),...(missing.length?{missing:[...new Set(missing)]}:{}),text,normalizedText,intent,confidence:Math.round(confidence*1000)/1000,confidenceLevel:status==='AMBIGUOUS'?'AMBIGUOUS':confidence>=0.85?'HIGH':confidence>=0.65?'MEDIUM':'LOW',entities,...(fulfillmentResult?{fulfillment:fulfillmentResult}:{}),...(compoundRequest?{requestType:'MULTI_ACTION',requestedIntents:[...explicitIntents]}:{}),matchedSemanticGroups:[...present.keys()],evidence:winner?.evidence??[],negativeEvidence:[...matches.filter(m=>m.negated).map(m=>({group:m.group,phrase:m.phrase,kind:'NEGATED'})),...(winner?.penalties??[])],context:{input:context,next:nextContext},alternatives:candidates.filter(c=>c.intent!==intent).slice(0,3),requiresConfirmation:intent?compiled.dictionary.intents.find(i=>i.code===intent)?.requiresConfirmation??false:false,debug:{...metrics,config,tokens,searchCorrections,matchedPhrases:matches,suppressedPrefixes:filtered.suppressed,actionFrames:structuralFrames,contextualFrames,candidates},latencyMs:Math.round((performance.now()-start)*1000)/1000};
}
export function advanceContext(context:Context,intent:string|null):Context {
 if(!intent)return {...context};
 if(['PRODUCT_RECOMMEND','PRODUCT_ALTERNATIVE','PRODUCT_SIMILAR','PRODUCT_NEW_ARRIVALS','PRODUCT_TRENDING','PRODUCT_BESTSELLERS'].includes(intent))return {previousIntent:intent,states:['PRODUCT_RESULTS_VISIBLE']};
 const mapping:Record<string,string[]>={PRODUCT_SEARCH:['PRODUCT_RESULTS_VISIBLE'],SELECT_PRODUCT:['PRODUCT_SELECTED','PRODUCT_RESULTS_VISIBLE'],ADD_TO_CART:['CART_NON_EMPTY'],VIEW_CART:['CART_NON_EMPTY'],CLEAR_CART:['CART_EMPTY'],ORDER_HISTORY:['ORDER_LIST_VISIBLE'],SELECT_ORDER:['ORDER_SELECTED'],START_CHECKOUT:['CHECKOUT_STARTED'],PRODUCT_COMPARE:['COMPARISON_ACTIVE'],VIEW_DELIVERY_SLOTS:['DELIVERY_SLOTS_VISIBLE'],FIND_PICKUP_LOCATION:['PICKUP_LOCATIONS_VISIBLE']};
 return {...(context.collection?{collection:context.collection}:{}),previousIntent:intent,states:mapping[intent]??context.states??[]};
}


function resolveRequest(compiled:Compiled,text:string,context:Context={},options:ScoringOptions={}) {
 const flat=resolveFlat(compiled,text,context,options);
 const priorActionFragment=languagePattern('engine.priorActionFragment.pattern.1').test(text.trim());
 const unrelatedPriorAction=priorActionFragment&&!context.orderReference&&!context.states?.includes('ORDER_SELECTED')&&((context.previousIntent==='PRODUCT_SEARCH'||context.states?.includes('PRODUCT_RESULTS_VISIBLE'))||!context.states?.includes('ORDER_LIST_VISIBLE')&&languagePattern('engine.unrelatedPriorAction.pattern.1').test(text.trim()));
 if(unrelatedPriorAction)Object.assign(flat,{status:'UNKNOWN',intent:null,message:responseMessage({status:'UNKNOWN',text,intent:null,missing:[],compoundRequest:false,requiresConfirmation:false}),confidence:0,confidenceLevel:'LOW',requiresConfirmation:false});
 const parsed=contextualRequest(compiled.dictionary,text,context,compiled);
 // A recognized transfer owns its linked destination verb, including negation.
 // Do not reinterpret only that verb as a fresh positive cart instruction.
 const scopedTransfer=flat.debug.actionFrames.some(f=>f.entities.sourceCollection&&(f.negated||f.instructional));
 const semantic=unrelatedPriorAction||flat.contextRequest||scopedTransfer||quotedSearch(text)?null:parsed.request;
 const parsedClauses=clauses(text,compiled.dictionary);
 if(!semantic&&parsedClauses.length&&!parsedClauses.some(clause=>!clause.negated)&&flat.status!=='AMBIGUOUS')Object.assign(flat,{status:'UNKNOWN',intent:null,message:responseMessage({status:'UNKNOWN',text,intent:null,missing:[],compoundRequest:false,requiresConfirmation:false}),confidence:0,confidenceLevel:'LOW',requiresConfirmation:false});
 const {pendingRequest:_,...retained}=parsed.context;
 const next:Context={...retained,...flat.context.next};
 delete next.pendingRequest;
 if(semantic){
  if(semantic.status==='NEEDS_CONTEXT')next.pendingRequest=parsed.sourceText;
  if(!semantic.missing.some(m=>m.includes('productText')||m==='items')&&semantic.entities.items.some(i=>i.productText))next.selectedItems=semantic.entities.items.filter(i=>i.productText&&(i.quantity===undefined||Number.isSafeInteger(i.quantity)&&i.quantity>0&&i.quantity<=1000000)).slice(0,50);
  if(semantic.entities.delivery?.addressReference)next.deliveryAddressReference=semantic.entities.delivery.addressReference;
  next.previousIntent=semantic.primaryIntent;
 } else {
  if(flat.status==='NEEDS_CONTEXT')next.pendingRequest=text;
  if(flat.status==='RESOLVED'&&typeof flat.entities.productText==='string')next.selectedItems=[{productText:flat.entities.productText,...(flat.entities.quantity!==undefined?{quantity:flat.entities.quantity}:{})}];
 }
 // Keep legacy intent/debug fields while exposing the structured semantic graph.
 const entities=semantic?{...flat.entities,...semantic.entities}:flat.entities;
 if(semantic){
  delete entities.product_reference;
  if(quotedNumericProduct(text)&&semantic.entities.items.length===1){
   delete entities.quantity;
   const item=semantic.entities.items[0];
   if(item.quantity!==undefined)entities.quantity=item.quantity;
   if(item.productText)entities.productText=item.productText;
  }
  if(semantic.entities.items.length>1){for(const key of languageValue<string[]>('engine.resolveRequest.value.2'))delete entities[key];entities.line_items=semantic.entities.items.map(i=>({description:i.productText,quantity:i.quantity}));}
 }
 // Only the verified shipment read can bypass compound handling after a
 // declined cancellation. Mixed write clauses retain the original guard.
 const singleTrackingRead=semantic?.status==='RESOLVED'&&semantic.clauses.length===2
  &&semantic.clauses[0].negated&&semantic.clauses[0].intent==='CANCEL_ORDER'
  &&!semantic.clauses[1].negated&&semantic.clauses[1].intent==='TRACK_ORDER'
  &&semantic.operations.length===1&&semantic.operations[0]==='TRACK_ORDER';
 const preserveLegacy=!!semantic&&!quotedNumericProduct(text)&&semantic.clauses.length===1&&flat.intent===semantic.primaryIntent&&semantic.primaryIntent!=='SELECT_DELIVERY_SLOT'&&semantic.references.length===0&&semantic.ambiguities.length===0;
 return {...flat,...(semantic?{status:preserveLegacy?flat.status:semantic.status,intent:preserveLegacy?flat.intent:semantic.status==='AMBIGUOUS'?null:semantic.primaryIntent,message:preserveLegacy?flat.message:semantic.message,missing:preserveLegacy?flat.missing:semantic.missing,confidence:preserveLegacy?flat.confidence:semantic.status==='AMBIGUOUS'?0:flat.intent===semantic.primaryIntent?flat.confidence:0.95,confidenceLevel:preserveLegacy?flat.confidenceLevel:semantic.status==='AMBIGUOUS'?'AMBIGUOUS':flat.intent===semantic.primaryIntent?flat.confidenceLevel:'HIGH',requiresConfirmation:preserveLegacy?flat.requiresConfirmation:semantic.operations.some(o=>o!=='SEARCH_PRODUCTS'),...(semantic.clauses.length>1&&!singleTrackingRead?{requestType:'COMPOUND',requestedIntents:semantic.intents}:{}),fulfillment:preserveLegacy?flat.fulfillment:{status:'NOT_EXECUTED',needsClarification:semantic.status!=='RESOLVED',unresolvedSlots:semantic.entities.items.map((_,i)=>({slot:languageTemplate('engine.resolveRequest.template.1', [i]),reason:'CATALOG_MATCHING_REQUIRED'}))}}:{}),primaryIntent:semantic?.status==='AMBIGUOUS'?null:semantic?.primaryIntent??flat.intent,entities,operations:semantic?.operations,actions:semantic?.actions,clauses:semantic?.clauses,clauseSourceText:semantic?.clauses.length?parsed.sourceText:undefined,references:semantic?.references,relationships:semantic?.relationships,slots:semantic?.slots,graph:semantic?.graph,ambiguities:semantic?.ambiguities,clarificationQuestion:semantic?.clarificationQuestion,context:{input:context,next}};
}

function resolveCommerce(compiled:Compiled,text:string,context:Context={},options:ScoringOptions={},preferContextual=false):Omit<ReturnType<typeof resolveRequest>,'status'>&{status:LanguageStatus;reason?:'unsupported_capability';unsupportedIntents?:string[];compoundInterpretationVersion?:1;requestedActions?:RequestedAction[]} {
 const question=canonicalRead(text)||wishlistReadRequested(text)||savedCollectionRequested(text)?undefined:questionRead(compiled.dictionary.languageKnowledge,text);
 if(question&&compiled.dictionary.intents.some(intent=>intent.code===question.intent)){
  const next={...context,previousIntent:question.intent};delete next.pendingRequest;delete next.pendingClarification;
  // Named question arguments replace stale identities and result sets exactly
  // like ordinary product reads. They identify text, never an invented SKU.
  delete next.selectedItems;delete next.resultSetItems;delete next.collection;delete next.activeSearch;
  next.states=context.states?.filter(state=>!['PRODUCT_SELECTED','PRODUCT_RESULTS_VISIBLE'].includes(state));
  const questionItems=Array.isArray(question.entities.items)?question.entities.items:typeof question.entities.productText==='string'?[question.entities]:[];
  if(questionItems.length)next.selectedItems=questionItems.map(item=>({productText:item.productText,...(item.quantity!==undefined?{quantity:item.quantity}:{})}));
  if(question.intent==='PRODUCT_SEARCH')next.states=[...next.states??[],'PRODUCT_RESULTS_VISIBLE'];
  const missing=question.question?(question.missing??['compatibilitySpecification']):[];
  return {...resolveRequest(compiled,'',{},options),status:question.question?'NEEDS_CONTEXT':'RESOLVED',text,normalizedText:normalize(text),intent:question.intent,primaryIntent:question.intent,
   confidence:1,confidenceLevel:'HIGH',message:question.question??'',...(question.question?{clarificationQuestion:question.question}:{}),missing,entities:question.entities,requiresConfirmation:false,operations:[],actions:[],
   fulfillment:{status:'NOT_EXECUTED',needsClarification:!!question.question,unresolvedSlots:missing.map(slot=>({slot,reason:question.reason??'COMPATIBILITY_EVIDENCE_REQUIRED'}))},context:{input:context,next}};
 }
 const fragment=context.pendingRequest?undefined:commerceFragment(compiled.dictionary,text);
 const wishlist=fragment && fragment.intent!=='PRODUCT_SEARCH' ? undefined : wishlistReadOrCommand(text);
 if(wishlist?.unsupportedCopy){
  return {...resolveRequest(compiled,'',{},options),status:'UNSUPPORTED',text,normalizedText:normalize(text),intent:null,primaryIntent:null,
   message:'Copying wishlist items while keeping them saved is not supported in chat yet. Open your wishlist and add the products to your cart; they will remain saved.',
   entities:{},requiresConfirmation:false,actions:[],operations:[],context:{input:context,next:context}};
 }
 if(wishlist?.canonical&&normalize(wishlist.canonical)!==normalize(text)){
  const result=resolveCommerce(compiled,wishlist.canonical,context,options);
  return {...result,text,normalizedText:normalize(text)};
 }
 const conversation=conversationIntent(text);
 if(conversation){
  const {pendingRequest:_,...next}=context;
  return {...resolveRequest(compiled,'',{},options),status:'RESOLVED',intent:conversation,primaryIntent:conversation,
   text,normalizedText:normalize(text),confidence:1,confidenceLevel:'HIGH',message:'',missing:[],entities:{},
   requiresConfirmation:false,operations:[],actions:[],fulfillment:languageValue<{ status: string; needsClarification: false; unresolvedSlots: never[]; }>('engine.resolveCommerce.value.1'),
   context:{input:context,next}};
 }
 const unsupported=unsupportedIntents(text);
 if(unsupported.length){
  const {pendingRequest:_,...next}=context;
  return {...resolveRequest(compiled,'',{},options),status:'UNSUPPORTED' as LanguageStatus,reason:'unsupported_capability',unsupportedIntents:unsupported.slice(0,32),
   text,normalizedText:normalize(text),intent:null,primaryIntent:null,confidence:1,confidenceLevel:'HIGH',requiresConfirmation:false,
   message:languageValue<string>('engine.resolveCommerce.value.2')+unsupported.slice(0,3).map(code=>code.toLowerCase().replaceAll('_',' ')).join(', ')+'. No changes have been made. If your request includes another action, please send that action separately.',
   missing:[],entities:{},operations:[],actions:[],clauses:[],references:[],relationships:[],slots:[],graph:undefined,ambiguities:[],clarificationQuestion:undefined,
   fulfillment:languageValue<{ status: string; needsClarification: false; unresolvedSlots: never[]; }>('engine.resolveCommerce.value.3'),context:{input:context,next}};
 }
 const pair=compoundRequest(text);
 if(pair&&pair.intents.every(intent=>compiled.dictionary.intents.some(definition=>definition.code===intent))){
  return {...resolveRequest(compiled,'',{},options),...pair,compoundInterpretationVersion:1,
   text,normalizedText:normalize(text),intent:null,primaryIntent:null,requestType:'MULTI_ACTION',requestedIntents:pair.intents,
   confidence:1,confidenceLevel:'HIGH',requiresConfirmation:true,
   fulfillment:{status:'NOT_EXECUTED',needsClarification:false,unresolvedSlots:pair.entities.items.map((_,i)=>({slot:languageTemplate('engine.resolveCommerce.template.1', [i]),reason:'CATALOG_MATCHING_REQUIRED'}))},
   context:{input:context,next:{}}};
 }
 const governed=governedRead(compiled.dictionary,text);
 const readCandidate=canonicalRead(text)??(governed&&canonicalRead(governed.text))??governed;
 // Whole-request domain reads own their terms before generic product-fact parsing.
 const fact=readCandidate ? undefined : productFactRead(text);
 if(fact){
  const {pendingRequest:_,pendingClarification:__,...next}=context;
  const missing=fact.entities.product_reference==='CURRENT'&&!context.states?.includes('PRODUCT_SELECTED')?['productReference']:[];
  const status:LanguageStatus=missing.length?'NEEDS_CONTEXT':'RESOLVED';
  const message=missing.length?responseMessage({status,text,intent:fact.intent,missing,compoundRequest:false,requiresConfirmation:false}):'';
  return {...resolveRequest(compiled,'',{},options),status,intent:fact.intent,primaryIntent:fact.intent,text,normalizedText:normalize(text),confidence:1,confidenceLevel:'HIGH',message,...(missing.length?{clarificationQuestion:message}:{}),missing,entities:fact.entities,requiresConfirmation:false,operations:[],actions:[],fulfillment:{status:'NOT_EXECUTED',needsClarification:missing.length>0,unresolvedSlots:missing.map(slot=>({slot,reason:'PRODUCT_SELECTION_REQUIRED'}))},context:{input:context,next:{...next,previousIntent:fact.intent}}};
 }
 // Established whole-request reads own phrases such as "for today". Do not
 // reinterpret their temporal wording as a required merchant catalog purpose.
 const readParaphrase=context.pendingRequest && readCandidate?.orderReference ? undefined : readCandidate;
 const purpose=readParaphrase?undefined:purposeSearch(compiled.dictionary,text);
 const contextual=readParaphrase||fragment&&fragment.intent!=='PRODUCT_SEARCH'?undefined:contextualShoppingSearch(compiled.languageKnowledge,text);
 // Preserve existing complete merchant-purpose requests. A governed concept
 // scoped to explicit relationships must keep its typed meaning even when its
 // canonical wording is also accepted by the open merchant-purpose parser.
 const legacyPurpose=!preferContextual&&purpose&&!contextual?.sentenceRoles?.length&&contextual?.relations.length===1&&!contextual.unresolved&&!contextual.relations[0].negated&&
  languageValue<string[]>('engine.legacyPurpose.value.1').includes(contextual.relations[0].relation)&&normalize(contextual.relations[0].value)===normalize(purpose.purpose)&&
  !compiled.dictionary.languageKnowledge?.concepts.some(concept=>concept.id===contextual.relations[0].conceptId&&concept.metadata?.usage==='explicit_relationship_only');
 const shopping=legacyPurpose||purpose?.gift?undefined:contextual;
 if(shopping){
  const original=resolveRequest(compiled,shopping.sentenceRoles?.length?shoppingUtterance(compiled.languageKnowledge,text)!.search.text:text,context,options);
  const ownsOtherAction=original.requestType||['RESOLVED','NEEDS_CONTEXT'].includes(original.status)&&original.intent&&!['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(original.intent);
  let base=resolveCommerce(compiled,shopping.coreText,{},options);
  // A complete explicit compatibility search may name an accessory whose noun
  // also appears in conversational groups (for example "charger"). Scope only
  // its already-validated product span as literal data. Evidence requirements
  // still force the action service to clarify before claiming a compatible SKU.
  if(!ownsOtherAction&&base.status==='UNKNOWN'&&shopping.relations.some(relation=>relation.relation==='compatibility_target')){
   const literal=resolveCommerce(compiled,languageValue<string>('engine.literal.value.1')+shopping.productText+'"',{},options);
   if(literal.status==='RESOLVED'&&literal.intent==='PRODUCT_SEARCH')base={...literal,entities:{...base.entities,...literal.entities}};
  }
  // A positive search command plus a proven single product read is required.
  // Vocabulary relationships never contribute scores or replace another action.
  const clarificationOnly=shopping.question&&shopping.relations.some(r=>compiled.languageKnowledge?.rules.some(rule=>rule.id===r.ruleId&&(rule.targetKind==='material'||rule.negated||rule.requiresClarification)));
  if((!ownsOtherAction||clarificationOnly)&&base.status==='RESOLVED'&&base.intent==='PRODUCT_SEARCH'&&!base.requestType&&!(base.entities.items?.length>1)){
   const intent=shopping.recommendation?'PRODUCT_RECOMMEND':'PRODUCT_SEARCH';
   // Named devices require the established evidence/clarification path. Do not
   // turn a device name into an activity or assert an accessory specification.
   const deviceRequirements=shopping.relations.filter(relation=>relation.relation==='compatibility_target'&&!relation.negated).map(({text,start,end,conceptId})=>({kind:compiled.dictionary.languageKnowledge?.concepts.find(concept=>concept.id===conceptId)?.metadata?.requiresExactModel===true?'device_compatibility':'named_device_compatibility',text,start,end}));
   const relations=shopping.relations.filter(relation=>relation.relation!=='compatibility_target');
   const shoppingContext={version:1,relations,coreText:shopping.coreText,...(shopping.sentenceRoles?{sentenceRoles:shopping.sentenceRoles,responsePreferences:shopping.responsePreferences}:{}),...(shopping.unresolved?{unresolved:shopping.unresolved}:{})};
   const entities={...base.entities,...(relations.length||shopping.sentenceRoles?.length||shopping.unresolved?.length?{shoppingContext}:{}),...(deviceRequirements.length?{evidenceRequirements:deviceRequirements}:{}),...(shopping.color?{color:shopping.color}:{})};
   if(shopping.question)return {...base,status:'NEEDS_CONTEXT',intent,primaryIntent:intent,text,normalizedText:normalize(text),entities,
    confidence:0,confidenceLevel:'LOW',message:shopping.question,clarificationQuestion:shopping.question,missing:['shoppingContext'],operations:[],actions:[],...discardedActionGraph(),
    fulfillment:languageValue<{ status: string; needsClarification: true; unresolvedSlots: { slot: string; reason: string; }[]; }>('engine.resolveCommerce.value.4'),
    context:{input:context,next:{...context,pendingRequest:text}}};
   return {...base,intent,primaryIntent:intent,text,normalizedText:normalize(text),entities,context:{input:context,next:{...base.context.next,previousIntent:intent}}};
  }
 }
 if(purpose){
  const safeFragment=!languagePattern('engine.safeFragment.pattern.1').test(purpose.coreText);
  let base=resolveCommerce(compiled,purpose.coreText,{},options);
  if(base.status==='UNKNOWN'&&safeFragment)base=resolveCommerce(compiled,languageValue<string>('engine.resolveCommerce.value.5')+purpose.coreText,{},options);
  if(purpose.browse&&base.status==='NEEDS_CONTEXT'&&base.intent==='PRODUCT_SEARCH'&&!base.requestType&&base.entities.productText===languageValue<string>('engine.resolveCommerce.value.6')&&base.entities.items?.length===1&&base.entities.items[0].reference==='UNSPECIFIED'){
   const {items:_,...entities}=base.entities;
   // A purpose browse has no selected item. Remove the placeholder and every
   // reference to it together, so the published semantics remain consistent.
   const actions=(base.actions??[]).map(action=>({...action,itemIndexes:[]}));
   const relationships=(base.relationships??[]).filter(link=>link.from!=='item1'&&link.to!=='item1');
   const references=(base.references??[]).filter(reference=>reference.expression!=='UNSPECIFIED');
   const slots=(base.slots??[]).filter(slot=>slot.code!=='PRODUCT_TEXT');
   const {pendingRequest:_pending,...next}=base.context.next;
   const graph=buildSemanticGraph({primaryIntent:'PRODUCT_SEARCH',clauses:base.clauses??[],actions,items:[],relationships,references,slots,
    ambiguities:base.ambiguities,compositionRules:compiled.dictionary.semanticModel?.compositionRules??[],compositionBySignature:compiled.compositionBySignature});
   base={...base,status:'RESOLVED',confidence:1,missing:[],entities,actions,relationships,references,slots,graph,message:'',clarificationQuestion:undefined,
    context:{...base.context,next},fulfillment:languageValue<{ status: string; needsClarification: false; unresolvedSlots: never[]; }>('engine.resolveCommerce.value.7')};
  }
  if(['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(base.intent??'')&&base.status==='RESOLVED'&&!base.requestType&&!(base.entities.items?.length>1)){
   const intent=languagePattern('engine.intent.pattern.1').test(text.trim())?'PRODUCT_RECOMMEND':base.intent;
   return {...base,intent,primaryIntent:intent,text,normalizedText:normalize(text),entities:{...base.entities,...(purpose.gift?{giftContext:purpose.gift}:{catalogPurpose:purpose.purpose})},context:{input:context,next:{...base.context.next,previousIntent:intent}}};
  }
 }
 // Explicit suffixes keep merchant-defined values separate from the product
 // argument. Reparse the entire search head before admitting these filters.
 const attributes=searchAttributes(compiled.dictionary,text);
 if(attributes){
  let base=resolveCommerce(compiled,attributes.coreText,{},options);
  // Explicit catalog filters provide the criteria for a generic product browse.
  // Admit only the same single unspecified-product shape used by purpose search;
  // field/value availability is still validated against the live merchant schema.
  if(!attributes.invalid&&Object.keys(attributes.fields).length>0&&base.status==='NEEDS_CONTEXT'&&base.intent==='PRODUCT_SEARCH'&&!base.requestType&&base.entities.productText===languageValue<string>('engine.resolveCommerce.value.8')&&base.entities.items?.length===1&&base.entities.items[0].reference==='UNSPECIFIED'){
   const {items:_,...entities}=base.entities;
   base={...base,status:'RESOLVED',confidence:1,missing:[],entities,message:'',clarificationQuestion:undefined};
  }
  const conflict=Object.entries(attributes.fields).some(([key,value])=>base.entities[key]!==undefined&&String(base.entities[key]).toLowerCase()!==value.toLowerCase());
  if(attributes.invalid||conflict||base.intent!=='PRODUCT_SEARCH'||base.status!=='RESOLVED'||base.requestType||base.entities.items?.length>1){
   const message=languageValue<string>('engine.message.value.1');
   return {...resolveCommerce(compiled,'',{},options),status:'NEEDS_CONTEXT',intent:'PRODUCT_SEARCH',primaryIntent:'PRODUCT_SEARCH',text,normalizedText:normalize(text),confidence:0,message,clarificationQuestion:message,missing:['searchAttributes'],context:{input:context,next:context}};
  }
  const standard=Object.fromEntries(Object.entries(attributes.fields).filter(([key])=>languageValue<string[]>('engine.standard.value.1').includes(key)));
  const merchantAttributes=Object.entries(attributes.fields).filter(([key])=>!languageValue<string[]>('engine.merchantAttributes.value.1').includes(key)).map(([name,value])=>({name,value}));
  return {...base,text,normalizedText:normalize(text),entities:{...base.entities,...standard,...(merchantAttributes.length?{merchantAttributes}:{})},context:{input:context,next:base.context.next}};
 }
 if(clearComparisonRequested(text)){
  const {pendingRequest:_,...next}=context;
  const base=resolveRequest(compiled,'',{},options);
  return {...base,status:'RESOLVED' as LanguageStatus,intent:'CLEAR_COMPARISON',primaryIntent:'CLEAR_COMPARISON',
   text,normalizedText:normalize(text),confidence:1,confidenceLevel:'HIGH',message:'',missing:[],entities:{},requiresConfirmation:false,
   operations:[],actions:[],fulfillment:languageValue<{ status: string; needsClarification: false; unresolvedSlots: never[]; }>('engine.resolveCommerce.value.9'),context:{input:context,next}};
 }
 const addressForm=languagePattern('engine.addressForm.pattern.1').test(text.trim());
 const read=addressForm?languageValue<{ text: string; intent: string; }>('engine.read.value.1'):readParaphrase??fragment;
 if(read){
  const result=resolveRequest(compiled,read.text,{},options);
  if(result.status==='RESOLVED'&&result.intent===read.intent){
   if('productText' in read && read.productText)result.entities.productText=read.productText;
   if('orderReference' in read && read.orderReference)result.entities.order_reference=read.orderReference;
   if('sort_by' in read && read.sort_by)result.entities.sort_by=read.sort_by;
   if('discountRanking' in read && read.discountRanking)result.entities.discountRanking=true;
   if('recommendationFollowup' in read && read.recommendationFollowup)result.entities.recommendationFollowup=read.recommendationFollowup;
   if('salesPeriod' in read && read.salesPeriod)result.entities.salesPeriod=read.salesPeriod;
   const debug={...result.debug,readParaphrase:{original:text,canonical:read.text}};
   return {...result,text,normalizedText:normalize(text),context:{input:context,next:{...context,...result.context.next,pendingRequest:undefined}},debug};
  }
 }
 if(clearCartRequested(text)){
  const cleared=resolveRequest(compiled,languageValue<string>('engine.canonical.value.1'),{},options);
  const debug={...cleared.debug,cartParaphrase:{original:text,canonical:languageValue<string>('engine.canonical.value.2')}};
  return {...cleared,text,normalizedText:normalize(text),context:{input:context,next:{...context,...cleared.context.next,pendingRequest:undefined}},debug};
 }
 // Whole checkout commands start a review; they never place an order.
 if(languagePattern('engine.resolveCommerce.pattern.1').test(text.trim())){
  const result=resolveRequest(compiled,languageValue<string>('engine.canonical.value.3'),{},options);
  return {...result,text,normalizedText:normalize(text),context:{input:context,next:result.context.next}};
 }
 const orderQueries=orderProductGuidance(text);
 const countedItems=orderQueries?.map(query => { const item = productGuidance(languageTemplate('engine.item.template.1', [query]))!; return {productText:item.query,quantity:item.quantity}; }) ?? countedProductGuidance(text);
 const guide=countedItems ? {query:countedItems[0].productText,quantity:countedItems[0].quantity,action:'cart'} : orderQueries ? {query:orderQueries[0],quantity:1,action:"cart"} : productGuidance(text);
 if(guide?.action===languageValue<string>('engine.resolveCommerce.value.10') && guide.query!==languageValue<string>('engine.lexical.value.5')){
  const removal=resolveRequest(compiled,text,context,options);
  if(removal.contextRequest || removal.intent==='REMOVE_FROM_CART' && removal.status==='RESOLVED')return removal;
 }
 if(guide && !context.pendingRequest){
  return {...resolveRequest(compiled,'',{},options),status:'NEEDS_CONTEXT' as LanguageStatus,intent:'PRODUCT_ACTION_CHOICE',primaryIntent:'PRODUCT_ACTION_CHOICE',
   text,normalizedText:normalize(text),confidence:1,confidenceLevel:'HIGH',message:'What would you like to do with this product?',
   entities:{productText:guide.query,quantity:guide.quantity,guideAction:guide.action,...(orderQueries ? {productQueries:orderQueries} : {}),...(countedItems ? {items:countedItems} : {})},missing:['product_selection'],requiresConfirmation:false,operations:[],actions:[],requestType:undefined,
   fulfillment:languageValue<{ status: string; needsClarification: true; unresolvedSlots: never[]; }>('engine.resolveCommerce.value.11'),context:{input:context,next:context}};
 }
 const resumed=transferReply(compiled.dictionary,text,context,parseRequest);
 const result=resolveRequest(compiled,resumed??text,resumed?{...context,pendingRequest:undefined}:context,options);
 // Flat keyword scoring can confuse a question or a partial selection with a
 // whole-cart instruction. Only the complete grammar above selects this route.
 if(result.intent==='CLEAR_CART'&&result.status==='RESOLVED'&&!result.requestType){
  const message=languageValue<string>('engine.message.value.2');
  return {...resolveRequest(compiled,'',{},options),status:'NEEDS_CONTEXT',intent:'CLEAR_CART',primaryIntent:'CLEAR_CART',text,normalizedText:normalize(text),confidence:0,confidenceLevel:'LOW',message,clarificationQuestion:message,missing:['cartClearRequest'],requiresConfirmation:true,operations:[],actions:[],fulfillment:languageValue<{ status: string; needsClarification: true; unresolvedSlots: never[]; }>('engine.resolveCommerce.value.12'),context:{input:context,next:context}};
 }
 if(!resumed&&result.status==='RESOLVED'&&!result.requestType&&result.intent==='PRODUCT_RECOMMEND'){
  const filters=recommendationFilters(text);
  if(filters)result.entities=filters;
 }
 if(!resumed&&result.status==='RESOLVED'&&!result.requestType&&['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(result.intent??'')){
  // A flat product argument may swallow a later imperative sentence. Preserve
  // the full message and ask for explicit scope instead of treating it as a read.
  if(!languagePattern('engine.resolveCommerce.pattern.2').test(text)&&languagePattern('engine.resolveCommerce.pattern.3').test(text)){
   const message=languageValue<string>('engine.message.value.3');
   return {...result,status:'NEEDS_CONTEXT',text,message,clarificationQuestion:message,confidence:0,confidenceLevel:'LOW',missing:['remainingActions'],operations:[],actions:[],...discardedActionGraph(),context:{input:context,next:{...context,pendingRequest:text}},fulfillment:languageValue<{ status: string; needsClarification: true; unresolvedSlots: { slot: string; reason: string; }[]; }>('engine.resolveCommerce.value.13')};
  }
  const requirements=evidenceRequirements(text);
  if(requirements.length)result.entities.evidenceRequirements=requirements;
 }
 return resumed?{...result,text,context:{input:context,next:result.context.next}}:result;
}


function resolveConstrained(compiled:Compiled,text:string,context:Context,options:ScoringOptions,preferContextual=false):ReturnType<typeof resolveCommerce> {
 // A whole published policy question can contain a hypothetical condition;
 // it requests information, not a conditional purchase or return action.
 if(questionRead(compiled.dictionary.languageKnowledge,text))return resolveCommerce(compiled,text,context,options);
 // Product-bearing orders must not fall through to existing-cart creation
 // when a quantity, unit, condition or second action was not understood.
 const issue = !context.pendingRequest && orderRequestIssue(text, !!orderProductGuidance(text));
 const structured = issue ? resolveCommerce(compiled, text, context, options) : undefined;
 // Existing typed plans own delivery, reorder and slot clarification. Preserve
 // their entities, confirmation requirement and pending conversation context.
 const preserve = structured && (structured.requestType || structured.status === 'UNSUPPORTED' || structured.status === 'DENIED' || structured.intent && structured.intent !== 'CREATE_ORDER');
 if (issue && !preserve) return {...resolveCommerce(compiled, '', {}, options), status:'NEEDS_CONTEXT', intent:'CREATE_ORDER', primaryIntent:'CREATE_ORDER', text, normalizedText:normalize(text), confidence:0, confidenceLevel:'LOW', message:issue, clarificationQuestion:issue, missing:['orderProducts'], entities:{}, operations:[], actions:[], requestType:undefined, fulfillment:languageValue<{ status: string; needsClarification: true; unresolvedSlots: never[]; }>('engine.resolveConstrained.value.1'), context:{input:context,next:context}};
 // "Not for gaming" negates an intended use, not every gaming-capable product.
 // Only a complete, proven contextual read may precede the exclusion parser.
 const shopping=contextualShoppingSearch(compiled.languageKnowledge,text);
 const rejectedDevice=shopping?.relations.some(relation=>relation.relation==='compatibility_target'&&relation.negated);
 if(shopping&&(rejectedDevice||!shopping.unresolved&&(shopping.relations.some(relation=>relation.negated)||shopping.sentenceRoles?.length))){
  const contextual=resolveCommerce(compiled,text,context,options,preferContextual);
  if(contextual.entities.shoppingContext&&(contextual.status==='RESOLVED'||rejectedDevice&&contextual.status==='NEEDS_CONTEXT'))return contextual;
 }
 const parsed=requestConstraints(text);
 // Capability recognition still owns unsupported outcomes for the full request.
 if(!parsed.constraints.length||unsupportedIntents(text).length)return resolveCommerce(compiled,text,context,options,preferContextual);
 const base=resolveCommerce(compiled,parsed.coreText,{},options);
 // A bare checkout head is sufficient to describe a conditional request, but
 // is not promoted to an executable resolution. Whole-command shortcuts such
 // as comparison clearing remain ineligible when qualifiers were removed.
 const semantic=base.status==='UNKNOWN'?semanticRequest(compiled.dictionary,parsed.coreText,{},true,compiled):null;
 const intent=base.intent==='CLEAR_COMPARISON'?null:base.intent??semantic?.primaryIntent??null;
 const entities:Record<string,any>={...base.entities,...(semantic?.entities??{}),requestConstraints:parsed.constraints};
 delete entities.recommendationFollowup;
 if(entities.productText==='*')delete entities.productText;
 const message=constraintQuestion(parsed.constraints);
 const graph=base.graph??semantic?.graph??languageValue<{ nodes: { id: string; kind: string; }[]; edges: never[]; constraints: never[]; truncated: false; }>('engine.graph.value.1');
 const constraintNodes=parsed.constraints.map((value,i)=>({id:languageTemplate('engine.constraintNodes.template.1', [i+1]),kind:value.kind,value}));
 return {...base,status:'NEEDS_CONTEXT',text,normalizedText:normalize(text),intent,primaryIntent:intent,message,clarificationQuestion:message,
  confidence:0,confidenceLevel:'LOW',entities,...(semantic?{actions:semantic.actions,operations:semantic.operations,clauses:semantic.clauses,clauseSourceText:parsed.coreText,relationships:semantic.relationships}:{}),
  missing:[...new Set([...(base.missing??[]),'requestConstraints'])],
  graph:{...graph,nodes:[...graph.nodes,...constraintNodes],edges:[...graph.edges,...constraintNodes.map(node=>({from:node.id,to:'request',relation:node.kind==='CONDITION'?'CONDITION_OF':'EXCLUDES_FROM'}))],constraints:[...graph.constraints,...constraintNodes.map(n=>n.id)]},
  fulfillment:{status:'NOT_EXECUTED',needsClarification:true,unresolvedSlots:parsed.constraints.map((_,i)=>({slot:languageTemplate('engine.resolveConstrained.template.1', [i]),reason:'CONSTRAINT_VERIFICATION_REQUIRED'}))},
  context:{input:context,next:{...context,pendingRequest:text}}};
}

type Understood=ReturnType<typeof resolveCommerce>&{searchUpdate?:boolean;clarificationReply?:boolean;interpretationText?:string};
function resolveUnderstanding(compiled:Compiled,text:string,context:Context,options:ScoringOptions):Understood {
 const courtesy=courtesyCoreText(text)??text;
 const envelope=!context.pendingRequest&&!context.pendingActionRequest&&!evidenceRequirements(text).length?(requestEnvelope(courtesy)??(courtesy!==text?courtesy:undefined)):undefined;
 if(envelope){
  const result=resolveUnderstanding(compiled,envelope,context,options);
  const next={...result.context.next,...(result.context.next.pendingRequest===envelope?{pendingRequest:text}:{})};
  // Contiguous request envelopes retain the customer's source coordinates.
  // Python validates these spans against the original message, not rewritten text.
  const source=result.interpretationText??envelope;
  const offset=text.indexOf(source);
  const shopping=result.entities.shoppingContext;
  if(shopping&&offset>=0&&text.indexOf(source,offset+1)<0){
   const shift=[...text.slice(0,offset)].length;
   const move=<T extends {start:number;end:number}>(row:T):T=>({...row,start:row.start+shift,end:row.end+shift});
   const shoppingContext={...shopping,relations:shopping.relations.map(move),
    ...(shopping.sentenceRoles?{sentenceRoles:shopping.sentenceRoles.map(move)}:{}),
    ...(shopping.unresolved?{unresolved:shopping.unresolved.map(move)}:{})};
   return {...result,text,normalizedText:normalize(text),interpretationText:text,
    entities:{...result.entities,shoppingContext},context:{input:context,next}};
  }
  return {...result,text,normalizedText:normalize(text),interpretationText:source,context:{input:context,next}};
 }
 // A dangling determiner or a bare tracking verb names no object. It must not
 // manufacture a product or assume that an order was supplied by the customer.
 if(languagePattern('engine.resolveUnderstanding.pattern.1').test(text.trim())){
  const base=resolveCommerce(compiled,'',{},options);
  return {...base,text,normalizedText:normalize(text),context:{input:context,next:context}};
 }
 // Discourse syntax applies to every supported read, not just product search.
 // Only published harmless whole sentences/lead-ins may be removed; substantive
 // clauses and extra actions must still be understood as a complete request.
 const lead=questionLeadIn(compiled.dictionary.languageKnowledge,text);
 const utterance=shoppingUtterance(compiled.languageKnowledge,lead??text);
 const questionSearch=utterance&&questionRead(compiled.dictionary.languageKnowledge,utterance.search.text)?.intent==='PRODUCT_SEARCH';
 const wrapped=!utterance?.budget&&utterance?.sentenceRoles.length&&(!utterance.sentenceRoles.some(role=>role.role==='search_prompt')||questionSearch)?utterance.search.text:undefined;
 const core=wrapped??lead;
 if(core&&core!==text&&!context.pendingActionRequest){
  const result=resolveUnderstanding(compiled,core,context,options);
  const definition=compiled.dictionary.intents.find(intent=>intent.code===result.intent);
  if(wrapped&&questionSearch&&result.status==='RESOLVED'&&result.intent==='PRODUCT_SEARCH'&&!result.requestType){
   const source=lead??text;
   const shoppingContext={version:1,relations:[],coreText:core,sentenceRoles:utterance!.sentenceRoles,responsePreferences:utterance!.responsePreferences};
   return {...result,text,normalizedText:normalize(text),interpretationText:source!==text?source:undefined,
    entities:{...result.entities,shoppingContext},context:{input:context,next:{...result.context.next,activeSearch:{text:source,contextual:true}}}};
  }
  const collectionCommand=wishlistReadOrCommand(core);
  if(collectionCommand?.canonical&&['ADD_TO_WISHLIST','REMOVE_FROM_WISHLIST','VIEW_WISHLIST'].includes(result.intent??'')&&!result.requestType){
   return {...result,text,normalizedText:normalize(text),interpretationText:result.interpretationText??core,context:{input:context,next:result.context.next}};
  }
  if(result.intent&&definition&&!definition.requiresConfirmation&&!result.requiresConfirmation&&!result.operations?.length&&!result.requestType&&
   !['ADD_TO_CART','REMOVE_FROM_CART','ADD_TO_WISHLIST','REMOVE_FROM_WISHLIST','CLEAR_CART','CLEAR_WISHLIST','CANCEL_ORDER','CREATE_ORDER','START_CHECKOUT'].includes(result.intent)&&
   ['RESOLVED','NEEDS_CONTEXT','UNSUPPORTED'].includes(result.status)&&!result.entities.shoppingContext&&
   !(wrapped&&['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(result.intent))){
   return {...result,text,normalizedText:normalize(text),interpretationText:result.interpretationText??core,context:{input:context,next:result.context.next}};
  }
 }
 const rejectedReference=recommendationReferenceFollowup(compiled.languageKnowledge,text);
 if(rejectedReference){
  const read=resolveCommerce(compiled,languageValue<string>('engine.canonical.value.4'),{},options);
  // Actual result identity and original catalog constraints are recovered by
  // the action service from customer-scoped assistant results, never guessed
  // from generic selectedItems emitted for a language-only product search.
  if(read.status==='RESOLVED'&&read.intent==='PRODUCT_RECOMMEND')return {...read,text,normalizedText:normalize(text),
   entities:{...read.entities,recommendationFollowup:'different',recommendationReference:rejectedReference},
   context:{input:context,next:{...read.context.next,...(context.activeSearch?{activeSearch:context.activeSearch}:{})}}};
 }
 if(!context.pendingClarification && !context.pendingRequest){
  // Reviewed sentence roles already identify the complete search and its
  // question. Do not let a broad recommendation paraphrase consume a later
  // sentence or shift the original evidence offsets.
  const sentenceSearch=contextualShoppingSearch(compiled.languageKnowledge,text);
  const canonical=sentenceSearch?.sentenceRoles?.length||sentenceSearch?.relations.some(relation=>relation.relation==='compatibility_target')?undefined:recommendationRequest(compiled.dictionary,text);
  if(canonical){
   const result=resolveUnderstanding(compiled,canonical,context,options);
   if(['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(result.intent??'')&&!result.requestType){
    // Keep evidence offsets tied to the actual customer's text, never the paraphrase.
    if(result.entities.evidenceRequirements)result.entities.evidenceRequirements=evidenceRequirements(text);
    return {...result,text,normalizedText:normalize(text),interpretationText:canonical};
   }
  }
 }
 if(context.pendingClarification){
  const pending=context.pendingClarification;
  const prior=resolveConstrained(compiled,pending.text,{},options);
  const direct=resolveConstrained(compiled,text,{},options);
  // A complete fresh request supersedes the question. Short slot answers must
  // instead be fully consumed against the independently revalidated request.
  const newRequest=languagePattern('engine.newRequest.pattern.1').test(text.trim());
  if(!newRequest||direct.status!=='RESOLVED'&&direct.status!=='UNSUPPORTED'&&direct.status!=='DENIED'){
   const combined=clarificationText(compiled.dictionary,pending,prior,text);
   if(combined&&combined.length<=4000){
    const result=resolveUnderstanding(compiled,combined,{},options);
    const preservesOperations=!prior.requestType||result.requestType===prior.requestType&&(prior.operations??[]).every(operation=>result.operations?.includes(operation));
    if(result.intent===prior.intent&&preservesOperations&&['RESOLVED','NEEDS_CONTEXT'].includes(result.status)){
     return {...result,text,normalizedText:normalize(text),clarificationReply:true,interpretationText:combined,context:{input:context,next:result.context.next}};
    }
   }
   const message=clarificationQuestion(pending.slot);
   return {...prior,status:'NEEDS_CONTEXT',intent:prior.intent,primaryIntent:prior.intent,text,normalizedText:normalize(text),confidence:0,confidenceLevel:'LOW',message,clarificationQuestion:message,missing:[...new Set([...(prior.missing??[]),pending.slot])],operations:[],actions:[],...discardedActionGraph(),clarificationReply:true,context:{input:context,next:context}};
  }
  const {pendingClarification:_,pendingRequest:__,...fresh}=context;
  context=fresh;
 }
 const priorQuestion=context.activeSearch&&questionRead(compiled.dictionary.languageKnowledge,shoppingUtterance(compiled.languageKnowledge,context.activeSearch.text)?.search.text??context.activeSearch.text)?.intent==='PRODUCT_SEARCH';
 const priorSearch=context.activeSearch&&(priorQuestion?resolveUnderstanding(compiled,context.activeSearch.text,{},options):resolveConstrained(compiled,context.activeSearch.text,{},options,context.activeSearch.contextual));
 const explicitCommerce=!!governedRequest(compiled.dictionary,text)||languagePattern('engine.explicitCommerce.pattern.1').test(text.trim());
 const completeBudgetSearch=!!shoppingUtterance(compiled.languageKnowledge,text)?.budget;
 const update=explicitCommerce||completeBudgetSearch?undefined:searchUpdate(compiled.dictionary,text,priorSearch?.entities,compiled.languageKnowledge);
 if(update?.price&&!update.invalid&&context.pendingRequest&&!context.activeSearch&&!context.pendingActionRequest){
  const pending=resolveConstrained(compiled,context.pendingRequest,{},options);
  if(['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(pending.intent??'')&&!pending.requestType){
   const price=extract(update.price,compiled.dictionary.entity_terms).price;
   if(price){
    const message=languageValue<string>('engine.message.value.4');
    // Understanding an edit does not authorize completing an unresolved goal.
    // Keep the original pending request, and explicitly say the edit is not applied.
    return {...resolveCommerce(compiled,'',{},options),status:'NEEDS_CONTEXT',intent:pending.intent,primaryIntent:pending.intent,text,normalizedText:normalize(text),confidence:0,
     entities:{price},message,clarificationQuestion:message,missing:['searchUpdate'],searchUpdate:true,operations:[],actions:[],
     context:{input:context,next:context}};
   }
  }
 }
 if(update&&(!context.pendingRequest||context.activeSearch)){
  const prior=priorSearch;
  const eligible=prior&&['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(prior.intent??'')&&!prior.requestType&&
   (prior.status==='RESOLVED'||prior.status==='NEEDS_CONTEXT'&&prior.entities.requestConstraints?.length);
  const combined=eligible&&updatedSearch(compiled.dictionary,context.activeSearch!.text,prior.entities,update,compiled.languageKnowledge);
  if(combined){
   const result=resolveConstrained(compiled,combined,{},options,!!prior!.entities.shoppingContext);
   if(['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(result.intent??'')&&!result.requestType&&['RESOLVED','NEEDS_CONTEXT'].includes(result.status))return {
    ...result,text,normalizedText:normalize(text),searchUpdate:true,interpretationText:combined,
    context:{input:context,next:{...result.context.next,activeSearch:{text:combined,...(result.entities.shoppingContext?languageValue<{ contextual: true; }>('engine.resolveUnderstanding.value.1'):{})}}},
   };
  }
  const message=context.activeSearch?'Which search details should I change? Please give a color, brand, size, material, flavor, quantity or budget, or send the complete search.':'Which product are you searching for? Send a complete search so I can apply this change.';
  return {...resolveCommerce(compiled,'',{},options),status:'NEEDS_CONTEXT',text,normalizedText:normalize(text),intent:'PRODUCT_SEARCH',primaryIntent:'PRODUCT_SEARCH',confidence:0,message,clarificationQuestion:message,missing:[context.activeSearch?'searchUpdate':'activeSearch'],searchUpdate:true,context:{input:context,next:context}};
 }
 const result=resolveConstrained(compiled,text,context,options);
 if(result.intent==='PRODUCT_RECOMMEND'&&typeof result.entities.productText==='string'){
  const noun=recommendationProductPhrase(text,result.entities.productText);if(noun)result.entities.productText=noun;
 }
 const discourseIssue=discourseProductIssue(compiled.languageKnowledge,text,result);
 if(discourseIssue){
  const preservedQuery=discourseIssue==='unparsed_sentences';
  const preservedIntent=preservedQuery||discourseIssue==='malformed_product_phrase';
  const query=typeof result.entities.productText==='string'?result.entities.productText:undefined;
  const message=preservedQuery&&query
   ?languageTemplate('engine.message.template.1', [query.slice(0,120)])
   :'Your message includes needs I have not fully understood. Which product or question should I focus on while keeping those needs in mind?';
  const requirements=evidenceRequirements(text);
  const next={...context,pendingRequest:text};delete next.activeSearch;delete next.pendingClarification;
  const entities:Record<string,any>={
   ...(preservedQuery&&typeof result.entities.productText==='string'?{productText:result.entities.productText}:{}),
   ...(result.entities.category?{category:result.entities.category}:{}),
   ...(result.entities.price?{price:result.entities.price}:{}),
   ...(result.entities.requestConstraints?{requestConstraints:result.entities.requestConstraints}:{}),
   ...(result.entities.shoppingContext?{shoppingContext:result.entities.shoppingContext}:{}),
  };
  if(requirements.length)entities.evidenceRequirements=requirements;
  return {...result,status:'NEEDS_CONTEXT',intent:preservedIntent?result.intent:null,primaryIntent:preservedIntent?result.primaryIntent:null,text,normalizedText:normalize(text),
   confidence:0,confidenceLevel:'LOW',message,clarificationQuestion:message,missing:['requestScope'],
   entities,operations:[],actions:[],...discardedActionGraph(),requiresConfirmation:false,
   fulfillment:languageValue<{ status: string; needsClarification: true; unresolvedSlots: { slot: string; reason: string; }[]; }>('engine.resolveUnderstanding.value.3'),
   context:{input:context,next}};
 }
 const wishlistReference=preservedWishlistReference(text,result.entities.productText);
 // Preserve punctuation in a proven full product reference; catalog identity
 // must not lose merchant name separators during linguistic normalization.
 if(wishlistReference){
  result.entities.productText=wishlistReference;
 }
 // Early purpose/search paths must retain the same evidence requirements as scored searches.
 if(result.status==='RESOLVED'&&!result.requestType&&['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(result.intent??'')){
  const requirements=evidenceRequirements(text);
  if(requirements.length)result.entities.evidenceRequirements=requirements;
 }
 const next={...result.context.next};
 delete next.pendingClarification;
 const pending=pendingClarification(result,text);
 if(pending)next.pendingClarification=pending;
 // Every complete new request supersedes the active search; stale searches are not revived.
 delete next.activeSearch;
 if(['PRODUCT_SEARCH','PRODUCT_RECOMMEND'].includes(result.intent??'')&&!result.requestType&&(result.status==='RESOLVED'||result.status==='NEEDS_CONTEXT'&&result.entities.requestConstraints?.length))next.activeSearch={text,...(result.entities.shoppingContext?languageValue<{ contextual: true; }>('engine.resolveUnderstanding.value.4'):{})};
 return {...result,context:{input:context,next}};
}

/** Product concepts enrich language meaning; they never replace merchant query text. */
function resolveWithProducts(compiled:Compiled,text:string,context:Context={},options:ScoringOptions={}):Understood&{product_meaning?:ProductMeaning;product_meanings?:ProductMeaning[]} {
 const result=resolveUnderstanding(compiled,text,context,options);
 if(languagePattern('engine.resolveWithProducts.pattern.1').test(text)||['UNSUPPORTED','DENIED','AMBIGUOUS'].includes(result.status)||result.requestType||languagePattern('engine.resolveWithProducts.pattern.2').test(text))return result;
 const productIntent=['PRODUCT_SEARCH','PRODUCT_RECOMMEND','PRODUCT_COMPARE','ADD_TO_CART','REMOVE_FROM_CART','ADD_TO_WISHLIST'].includes(result.intent??'');
 if(!productIntent&&result.status!=='UNKNOWN')return result;
 const source=(value:string)=>{
  const escaped=value.replace(languagePattern('engine.escaped.pattern.1'),'\\$&').replace(languagePattern('engine.escaped.pattern.2'),languageValue<string>('engine.escaped.value.1'));
  return new RegExp(escaped,'i').exec(text)?.[0]??value;
 };
 const items=result.entities.items;
 if(productIntent&&Array.isArray(items)&&items.length>1){
  const meanings=items.filter(item=>typeof item.productText==='string').map(item=>productMeaning(source(item.productText),result.intent,{...item})).filter((meaning):meaning is ProductMeaning=>!!meaning);
  return meanings.length?{...result,product_meanings:meanings}:result;
 }
 const singleItem=Array.isArray(items)&&items.length===1?items[0]:undefined;
 const raw=typeof result.entities.productText==='string'?source(result.entities.productText):typeof singleItem?.productText==='string'?source(singleItem.productText):text;
 const meaning=productMeaning(raw,productIntent?result.intent:undefined,{...result.entities,...singleItem},undefined,text,compiled.languageKnowledge);
 return meaning?{...result,product_meaning:meaning}:result;
}

/** Customer action counts are descriptive and never replace the execution plan. */
function resolveCore(compiled:Compiled,text:string,context:Context={},options:ScoringOptions={}):ReturnType<typeof resolveWithProducts>&IntentCount&{compoundReply?:CompoundReply} {
 const savedQuestion=savedCollectionRequested(text);
 const pendingSaved=!!context.pendingRequest&&savedCollectionRequested(context.pendingRequest);
 if(savedQuestion||pendingSaved){
  const {pendingRequest:_,pendingClarification:__,pendingActionRequest:___,activeSearch:____,...fresh}=context;
  const choice=pendingSaved&&!savedQuestion?savedCollectionChoice(text):undefined;
  if(choice){
   const result=resolveCore(compiled,choice.text,fresh,options);
   return {...result,text,normalizedText:normalize(text),clarificationReply:true,interpretationText:choice.text,context:{input:context,next:result.context.next}};
  }
  const original=savedQuestion?text:context.pendingRequest!;
  const result=resolveCore(compiled,'',fresh,options);
  return {...result,status:'NEEDS_CONTEXT',text,normalizedText:normalize(text),intent:null,primaryIntent:null,
   confidence:1,confidenceLevel:'HIGH',message:savedCollectionQuestion,clarificationQuestion:savedCollectionQuestion,
   missing:['savedCollection'],entities:{},requiresConfirmation:false,operations:[],actions:[],
   fulfillment:languageValue<{ status: string; needsClarification: true; unresolvedSlots: never[]; }>('engine.resolveCore.value.1'),
   context:{input:context,next:{...fresh,pendingRequest:original}}};
 }
 // A complete collection read starts a new request. Never use its wording as
 // a missing product/address in an earlier write or compound clarification.
 if((context.pendingRequest||context.pendingClarification||context.pendingActionRequest)&&wishlistReadRequested(text)){
  const {pendingRequest:_,pendingClarification:__,pendingActionRequest:___,...fresh}=context;
  const result=resolveCore(compiled,text,fresh,options);
  return {...result,context:{input:context,next:result.context.next}};
 }
 if(context.pendingActionRequest){
  const original=context.pendingActionRequest;
  const prior=resolve(compiled,original,{},options);
  const reply=compoundReply(compiled.dictionary,original,text,prior,value=>resolve(compiled,value,{},options));
  const result=reply.disposition==='filled'||reply.disposition==='replaced'?resolve(compiled,reply.text,{},options):prior;
  return {...result,compoundInterpretationVersion:reply.disposition==='filled'||reply.disposition==='replaced'?result.compoundInterpretationVersion:undefined,compoundReply:reply.disposition,clarificationReply:true,interpretationText:reply.text};
 }
 const result=resolveWithProducts(compiled,text,context,options);
 const source=result.interpretationText??(context.pendingRequest&&result.clauses?.length&&!result.clauses.every(clause=>text.includes(clause.text))?context.pendingRequest:text);
 // A domain wrapper may have parsed a stripped core (such as a conditional
 // request). Its marker is valid only for this entire final source and status.
 if(result.compoundInterpretationVersion===1){
  const complete=compoundRequest(source);
  if(result.status!=='RESOLVED'||result.entities.requestConstraints||!complete||JSON.stringify(complete.requestedActions)!==JSON.stringify(result.requestedActions)){
   delete result.compoundInterpretationVersion;
   delete result.requestedActions;
  }
 }
 // A supported complete composition has one interpretation source. Counts and
 // semantic clauses are projections of that parse, never permission to execute.
 const counts:IntentCount=result.compoundInterpretationVersion===1&&result.requestedActions
  ?{requestedActionsVersion:1,requestedActions:result.requestedActions,requestedActionIssues:[],intentCount:2,uniqueIntentCount:2,intentCountStatus:'EXACT'}
  :countIntents(compiled.dictionary,source,context,result);
 // A later sentence may correct or negate a previously recognized action.
 // If that sentence was not parsed, hold the complete request instead of
 // dispatching the surviving single clause or manufacturing a new write.
 if(hasUnparsedSentenceAction(source,compiled.dictionary,clauses(source,compiled.dictionary))){
  const message=languageValue<string>('engine.message.value.5');
  return {...result,...counts,status:'NEEDS_CONTEXT',intent:null,primaryIntent:null,
   confidence:0,confidenceLevel:'LOW',message,clarificationQuestion:message,
   missing:['requestScope'],entities:{},operations:[],actions:[],...discardedActionGraph(),requestType:undefined,
   requestedIntents:undefined,requiresConfirmation:false,
   fulfillment:languageValue<{ status: string; needsClarification: true; unresolvedSlots: never[]; }>('engine.resolveCore.value.2'),
   context:{input:context,next:context}};
 }
 if(actionInterpretationConflicts(result,counts)){
  return {...result,...counts,status:'NEEDS_CONTEXT',confidence:0,confidenceLevel:'LOW',
   requestedActionIssues:[...counts.requestedActionIssues,'INTERPRETATION_CONFLICT'],
   missing:[...new Set([...(result.missing??[]),'requestedActions'])],
   message:'Please confirm the complete request, including each action and its product. No changes have been made.',
   context:{input:context,next:{...result.context.next,pendingRequest:source}},
   fulfillment:languageValue<{ status: string; needsClarification: true; unresolvedSlots: never[]; }>('engine.resolveCore.value.3')};
 }
 return {...result,...counts};
}

/** Automatic new recovery is limited to a validated single read; other candidates cannot authorize actions. */
export function resolve(compiled:Compiled,text:string,context:Context={},options:ScoringOptions={}):ReturnType<typeof resolveCore>&{correctionEvidence?:CorrectionTrace} {
 return withRecognitionRules(compiled.recognition,()=>resolveScoped(compiled,text,context,options));
}
function resolveScoped(compiled:Compiled,text:string,context:Context,options:ScoringOptions):ReturnType<typeof resolveCore>&{correctionEvidence?:CorrectionTrace} {
 const result=resolveCore(compiled,text,context,options);
 if(result.status==='RESOLVED'&&result.intent==='PRODUCT_SEARCH'&&!result.requestType&&!quotedSearch(text)&&conflictingPriceBounds(text)){
  const message='Please give a non-empty price range: the minimum must not exceed the maximum.';
  return {...result,status:'NEEDS_CONTEXT',confidence:0,confidenceLevel:'LOW',message,clarificationQuestion:message,
   missing:['price'],operations:[],actions:[],...discardedActionGraph(),context:{input:context,next:context},
   fulfillment:{status:'NOT_EXECUTED',needsClarification:true,unresolvedSlots:[{slot:'price',reason:'CONFLICTING_BOUNDS'}]}};
 }
 const trace=correctionProposals(compiled,text);
 for(const change of [...scopedTokenCorrections(text),...searchCommandCorrections(text)]){
  const reviewed=evidence(text,change,'reviewed-command',true,'scoped_existing_rule');
  const duplicate=trace.candidates.findIndex(c=>c.start===reviewed.start&&c.end===reviewed.end&&c.candidate===reviewed.candidate);
  if(duplicate>=0)trace.candidates.splice(duplicate,1);
  if(trace.candidates.length<8)trace.candidates.push(reviewed);
 }
 if(!trace.candidates.length)return result;
 if(['DENIED','UNSUPPORTED','AMBIGUOUS'].includes(result.status))return {...result,correctionEvidence:trace};
 const protectedCommand=trace.candidates.some(c=>c.source==='protected-command');
 const unresolvedCommand=trace.candidates.some(c=>c.source==='compiled-read-command'&&!c.accepted);
 const readIntents=new Set(['PRODUCT_SEARCH','PRODUCT_RECOMMEND','PRODUCT_COMPARE','TRACK_ORDER','VIEW_CART','VIEW_WISHLIST','ORDER_HISTORY','ORDER_DETAILS','PAYMENT_METHODS','RETURN_POLICY','DELIVERY_COST','STORE_HOURS']);
 // A recognized later write must not swallow an unresolved leading command.
 if(protectedCommand||(unresolvedCommand&&result.status==='RESOLVED'&&!readIntents.has(result.intent??''))){
  const blank=resolveCore(compiled,'',{},options);
  return {...blank,text,normalizedText:normalize(text),status:'NEEDS_CONTEXT',intent:null,primaryIntent:null,confidence:0,confidenceLevel:'LOW',
   message:'Please spell out the action you want. No changes have been made.',missing:languageValue<string[]>('engine.resolve.value.1'),
   context:{input:context,next:context},correctionEvidence:trace};
 }
 const candidate=trace.candidates.find(c=>c.source==='compiled-read-command'&&c.reason==='unique_read_candidate');
 if(candidate&&result.status==='UNKNOWN'&&!context.pendingRequest&&!context.pendingActionRequest&&!context.pendingClarification){
  const chars=[...text],corrected=chars.slice(0,candidate.start).join('')+candidate.candidate+chars.slice(candidate.end).join('');
  const recovered=resolveCore(compiled,corrected,context,options);
  if(recovered.status==='RESOLVED'&&readIntents.has(recovered.intent??'')&&recovered.intentCount===1&&recovered.intentCountStatus==='EXACT'){
   candidate.accepted=true;candidate.reason='validated_single_read';
   return {...recovered,text,normalizedText:normalize(text),interpretationText:corrected,correctionEvidence:trace};
  }
 }
 return {...result,correctionEvidence:trace};
}
