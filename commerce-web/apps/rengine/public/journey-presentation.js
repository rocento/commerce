// Present recorded facts only. Missing capture is never evidence that a stage was skipped.
import {stepInsight} from './trace-diagnostics.js';
const definitions={
 http_boundary:['service','Internal service call','Python measured this transport boundary. Peer handler duration is a separate clock; transport success does not prove business completion.','HTTP'],
 service_span:['service','Connected service evidence','A service supplied this linked boundary record. Durations use that service’s local clock and cannot be placed on the Python time axis.','SVC'],
 provider_attempt:['model','Provider dispatch attempt','Records an actual provider transport dispatch and its adapter result. Adapter validation is separate from downstream interpretation and task completion.','AI'],
 customer_request:['customer','Shopper message','The shopper’s message entered the assistant.','IN'],
 intent_retrieval:['retrieval','Find helpful examples (RAG)','The assistant looked for relevant intent examples to support interpretation. Retrieved examples do not prove that a model used them.','RAG'],
 initial_language_result:['language','Understand the message','The language engine returned its first interpretation of the message.','LE'],
 interpretation_before_fallback:['decision','Check before AI fallback','This interpretation was recorded before model fallback. Inspect its status to understand what still needed resolution.','IF'],
 language_rule_evidence:['rules','Check language rules','Candidate rules were scored against the message. Inspect the selected candidate and the matching rule definition.','RULE'],
 language_model_request:['model','Prepare the AI request','The assistant prepared instructions, conversation input and an output schema for the model. A request record alone does not prove completion.','AI'],
 provider_wire_payload:['model','Prepare provider input','The redacted payload prepared for the model provider was captured here.','AI'],
 language_model_response:['model','Read the AI response','The model returned an interpretation response. Downstream validation still determines whether it can be accepted.','AI'],
 model_proposal:['decision','Review the AI suggestion','The model proposed an intent. This proposal is evidence of interpretation, not permission to execute a commerce action.','IF'],
 final_result:['response','Request outcome','The recorded outcome, response and routing reason close this captured request.','OUT'],
};
// Exact captured function names: do not infer behavior from similar-looking names.
const functions={
 'TurnRouting.select':['Choose how to handle the request','Selects the execution path for this request using the shopper’s context, the kind of task and the available services. It prepares that path before any shopping action runs. The “Execution path selected” step records the chosen path and reason.'],
 resolve:['Ask the language engine','Sends the message and conversation context to the language engine, then checks its response. This helps identify what the shopper wants. The interpretation and rule steps show what the engine understood.'],
 interpret_resolution:['Validate the interpretation','Checks that the language result is usable and attaches it to the trusted shopper context. It then chooses a next step. Invalid or unavailable results lead to an unavailable response instead of a shopping action.'],
 route:['Choose the next action','Examines the interpreted request to decide what should happen next: handle a shopping task, ask for clarification, use AI help when allowed, or report that the request cannot be handled. The function record alone does not reveal which option was chosen.'],
 'ShoppingCatalog.discover':['Read the store’s catalog structure','Looks up the store’s product attributes and default currency when catalog discovery is available. These details help the assistant understand which product information it can search and use.'],
 'ShoppingCatalog.call':['Request catalog information','Checks that the requested catalog tool is allowed and within the request’s limits, calls it, and validates the returned data. Other recorded evidence shows which products or facts were found.'],
 'CommerceTools.discounts':['Look up discounts','Requests discount recommendations from the store so the assistant can answer using store data.'],
 'CommerceTools.bestsellers':['Look up popular products','Requests the store’s best-selling products for the selected sales period.'],
 'CommerceTools.cart':['Read the shopping cart','Requests the shopper’s current cart so the assistant can use its contents in the response.'],
 'CommerceTools.change_cart':['Request a cart change','Sends the requested cart change to the store. The store checks access and processes the operation; the recorded outcome must be checked to confirm that the change succeeded.'],
 'CommerceTools.transfer_wishlist_to_cart':['Move saved products to the cart','Requests a transfer of selected wishlist products into the shopping cart. Check the recorded result to see whether the transfer was accepted.'],
 'CommerceTools.search_cart_product':['Find the product for a cart request','Searches the store for products matching the shopper’s wording so a cart request can refer to a specific product.'],
 'CommerceTools.wishlist':['Read saved products','Requests the shopper’s wishlist to find which products they have saved.'],
 'CommerceTools.remove_wishlist_item':['Request removal from saved products','Asks the store to remove a specific product from the shopper’s wishlist. Check the recorded outcome to confirm removal.'],
 'CommerceTools.add_wishlist_item':['Request saving a product','Asks the store to add a specific product to the shopper’s wishlist. Check the recorded outcome to confirm it was saved.'],
 'CommerceTools.product':['Look up product details','Requests details for a specific product so the assistant can answer from store information.'],
 'CommerceTools.delivery':['Look up delivery information','Requests delivery information from the store to help answer the shopper’s delivery question.'],
 'CommerceTools.locations':['Look up store locations','Requests the store’s location information for the assistant’s response.'],
 'CommerceTools.support_tickets':['Read support requests','Requests the shopper’s support tickets so the assistant can report on existing requests.'],
 'CommerceTools.support_ticket':['Read a support request','Requests the details of one support ticket so the assistant can answer about that specific request.'],
 'CommerceTools.call':['Send an order operation','Passes the named order operation and its arguments to the store’s order service. This function record alone does not identify the operation or confirm its success.'],
 'CommerceTools.orders':['Read order history','Requests the shopper’s orders so the assistant can answer questions about their purchases.'],
 'CommerceTools.oldest_order':['Look up the oldest order','Requests the shopper’s oldest order information from the store.'],
 'CommerceTools.order_by_number':['Find an order by number','Requests the order matching the supplied order number so the assistant can answer about the correct purchase.'],
 'CommerceTools.create_ticket':['Request a new support ticket','Sends the support request to the store. Check the recorded result for confirmation that a ticket was created.'],
};
Object.assign(definitions,{
 catalog_filter:['decision','Filter returned products','Checks products already returned by the catalog and keeps those that satisfy the recorded checks. This step runs inside the assistant and makes no new catalog request.','IF'],
 execution_route:['decision','Execution path selected','Records the choice between the rule-driven flow, existing handlers and the core execution system. The options below explain the selected path and the alternatives. Choosing a path happens before the shopping action and does not confirm its success.','IF'],
 handler_dispatch:['decision','Start the selected task','Passes the request to the handler responsible for the selected shopping task. The recorded handler, journey and intent identify what is about to run; later steps show its result.','IF'],
 domain_evidence:['decision','Check product requirements','Records how candidate products compare with the relevant requirements. Verified means supported by the checked evidence; unknown means evidence is missing; unmet means a requirement was not satisfied.','IF'],
 provider_invalid_response:['model','AI response could not be accepted','The provider response failed a required validation check. The captured details explain the validation problem; the final request outcome shows how the assistant handled it.','AI'],
});
const categories={service:'Service boundary',customer:'Shopper message',retrieval:'RAG retrieval',language:'Language engine',decision:'Decision',rules:'Rules',model:'AI model',response:'Final response',python:'Internal processing'};
const summaries={
 customer_request:'The shopper’s message entered the assistant.',
 intent_retrieval:'The capture records a search for relevant intent examples.',
 initial_language_result:'The language engine returned its first interpretation.',
 interpretation_before_fallback:'This interpretation was captured before model fallback.',
 language_rule_evidence:'The capture records which rules were evaluated.',
 language_model_request:'Model instructions and conversation input were prepared.',
 provider_wire_payload:'The capture records the payload prepared for the model.',
 language_model_response:'The model returned a response for validation.',
 model_proposal:'The model proposed how to interpret the message.',
 final_result:'Inspect the recorded response and its routing reason.',
};
function stepSummary(step,type,evidence){
 if(type==='service')return `${evidence.operation??'Operation not recorded'} · ${step.service??'Service not recorded'}. Inspect the explicit link and timing scope.`;
 const insight=stepInsight(step);if(insight)return insight;
 if(step.stage==='catalog_filter')return `${evidence.products_before??'Unknown'} products checked; ${evidence.products_after??'unknown'} kept. No new catalog request.`;
 if(type==='python'){const purpose=functions[step.title??evidence.function];return purpose?purpose[1].split('. ')[0]+'.':'The purpose of this function is not documented yet. Inspect its captured source and evidence.';}
 if(step.stage==='intent_retrieval'){
  const count=Array.isArray(evidence.examples)?evidence.examples.length:typeof evidence.count==='number'?evidence.count:null;
  if(evidence.status==='retrieved')return count===null?'Found matching examples to help understand the message.':`Found ${count} matching example${count===1?'':'s'} to help understand the message.`;
  if(evidence.status==='empty')return 'The lookup finished, but found no matching examples.';
  if(evidence.status==='unavailable')return 'The example lookup was unavailable for this request.';
  if(evidence.status==='unconfigured')return 'Example lookup was not set up for this request.';
 }
 if(step.stage==='language_rule_evidence'&&step.rules?.candidates?.length){
  const count=step.rules.candidates.length;
  return `${count} possible rule match${count===1?' is':'es are'} available to inspect.`;
 }
 return summaries[step.stage]??definitions[step.stage]?.[2]??'This step was recorded without a documented explanation. Inspect its evidence for details.';
}
function readableState(step,type,evidence){
 const outcome=evidence.outcome??evidence.status;
 if(type==='service')return ({dispatched:'Dispatch recorded',received:'HTTP response received',completed:'Remote handler completed',failed:'Boundary failed',cancelled:'Boundary cancelled',completion_not_captured:'Completion not captured'})[outcome]??'Boundary details available';
 if(step.stage==='provider_attempt')return ({completed:'Adapter accepted response',failed:'Provider attempt failed',cancelled:'Provider attempt cancelled',incomplete:'Completion not captured'})[outcome]??'Dispatch details available';
 if(step.stage==='catalog_filter')return typeof evidence.products_after==='number'?`${evidence.products_after} products kept`:'Filter details available';
 if(type==='python')return ({running:'Running now',returned:'Function finished',success:'Function finished',error:'Function failed','completion not captured':'Finish not captured'})[outcome]??'Function details available';
 if(step.stage==='intent_retrieval')return ({retrieved:'Examples found',empty:'No examples found',unavailable:'Lookup unavailable',unconfigured:'Lookup not set up'})[outcome]??'Lookup details available';
 if(step.stage==='final_result')return ({completed:'Request completed',unavailable:'Request unavailable',disconnected:'Connection ended',denied:'Request denied',error:'Request failed',failed:'Request failed'})[outcome]??(outcome?String(outcome).replaceAll('_',' '):'Outcome not captured');
 if(outcome==='error')return 'Error reported';
 return ({customer_request:'Message received',initial_language_result:'Interpretation available',interpretation_before_fallback:'Checkpoint saved',language_rule_evidence:'Rule results available',language_model_request:'AI input prepared',provider_wire_payload:'Request details available',language_model_response:'AI response received',model_proposal:'Suggestion available'})[step.stage]??'Details available';
}
function functionResult(evidence){
 return ({running:'This step is still running; its result is not available yet.',returned:'This step returned without throwing an error. Its return value is not captured here, so this alone does not confirm that the requested action succeeded.',success:'This step returned without throwing an error. Check the recorded action result before treating the task as successful.',error:'This step stopped with an error. Check the surrounding evidence and final request outcome to see whether the assistant recovered.','completion not captured':'The start was recorded, but the end is missing. This does not establish whether the step succeeded or failed.'})[evidence.outcome]??'The completion state was not captured for this function.';
}
function catalogDescription(step,evidence){
 if((step.title??evidence.function)!=='ShoppingCatalog.call')return null;
 const details=evidence.details;
 if(!details?.operation)return null;
 const purposes={get_catalog_schema:['Read catalog structure','Loads the store’s product fields and default currency before searching.'],search_products:['Search catalog for products','Searches the store using the recorded query and filters below. Multiple searches can use different criteria; the trace does not label their intent as a retry or an exact-name check.'],get_product:['Read a product','Looks up one product from the catalog.'],compare_products:['Read products for comparison','Loads the requested products for comparison.']};
 let [title,description]=purposes[details.operation]??['Run catalog operation','Runs the catalog operation recorded below.'];
 const criteria=details.criteria??{};
 const hasFilters=['category_id','min_price','max_price'].some(key=>criteria[key]!==null&&criteria[key]!==undefined&&criteria[key]!=='')||criteria.in_stock===true||['attributes','predicates','excluded_product_ids'].some(key=>Array.isArray(criteria[key])&&criteria[key].length>0);
 if(details.operation==='search_products'){
  if(hasFilters){title='Search with filters';description='Sends a new catalog search using the recorded filters'+(criteria.query&&criteria.query!=='*'?' and search text':'')+'. Filtering happens in the catalog request; this is not a local filter of earlier results.';}
  else if(typeof criteria.query==='string'&&criteria.query.trim()&&criteria.query!=='*'){title='Search by text';description='Sends a new catalog search for the recorded words. No category, price, stock or attribute filters were recorded for this call.';}
  else if(criteria.query==='*'){title='Browse catalog';description='Requests catalog products without a specific search phrase or recorded filters.';}
  else{title='Search catalog';description='A catalog search was recorded, but its criteria are missing. Its search type cannot be determined.';}
 }
 const query=details.criteria?.query;
 const count=details.products_returned;
 const result=evidence.outcome==='returned'?(details.operation==='get_catalog_schema'?(details.schema_returned?'Catalog structure received.':'No catalog structure returned.'):typeof count==='number'?`${count} product${count===1?'':'s'} returned by this call. Later filtering may narrow these results.`:null):null;
 return {title,description,summary:[typeof query==='string'?`Query: “${query}”.`:description,result].filter(Boolean).join(' '),...(result?{stateLabel:details.operation==='get_catalog_schema'?'Catalog response received':`${count} products returned`,resultExplanation:result}:{})};
}
function humanFunctionName(name){return String(name??'Internal processing').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_.]+/g,' ').replace(/\s+/g,' ').replace(/^./,value=>value.toUpperCase());}
export function describeStep(step){
 const known=definitions[step.stage];
 const [type,title,description,icon]=known??[step.kind==='python'?'python':'decision',step.title??step.stage,'Inspect the captured evidence for this execution boundary.',step.kind==='python'?'fn':'IF'];
 const evidence=step.evidence??{};
 const purpose=type==='python'?functions[step.title??evidence.function]:null;
 return {type,title:type==='python'?(purpose?.[0]??humanFunctionName(step.title??evidence.function)):step.rules?.candidates?.length===1&&step.title?.includes(' / ')?step.title:title,description:type==='python'?(purpose?.[1]??'This function was recorded, but a plain-language explanation is not available for it yet. Its name alone does not establish what it did. Use the captured source and evidence to inspect its behavior.'):description,resultExplanation:type==='python'?functionResult(evidence):null,summary:stepSummary(step,type,evidence),category:categories[type]??'Recorded step',icon,badgeLabel:({IN:'Input',IF:'Decision',fn:'Function',LE:'Language',RULE:'Rule',AI:'AI model',RAG:'Retrieval',OUT:'Output'})[icon]??icon,important:['retrieval','rules','decision','response'].includes(type),stateLabel:readableState(step,type,evidence),status:evidence.outcome??evidence.status??null,...catalogDescription(step,evidence)};
}

export function describeExecutionRoute(evidence={}){
 const reasons={
  existing_deterministic:'The caller selected the existing rule-driven flow for this task. This choice takes priority over the model-backed paths.',
  provider_unavailable:'No model runtime was available, so routing selected the deterministic path.',
  flag_off:'A model runtime was available, but the core execution system was disabled. Routing selected the existing handler path.',
  journey_disabled:'Core execution was enabled, but this type of task was not enabled for it. Routing selected the existing handler path.',
  core_unavailable:'The core definitions, provider requirements, or runtime binding could not be prepared. Routing fell back to the existing handler before execution.',
  core_selected:'A model runtime was available, core execution was enabled for this task, and its definitions and provider requirements passed preparation.',
 };
 const titles={deterministic:'Rule-driven flow',legacy:'Existing handler flow',core:'Core execution flow'};
 const purposes={deterministic:'Uses the existing deterministic task flow. Selecting it does not by itself describe every downstream service call.',legacy:'Uses the existing handlers when the core execution path is disabled or cannot be prepared.',core:'Uses the enabled core execution system after checking task definitions and provider requirements.'};
 const explanations={
  existing_deterministic:{legacy:'Not selected because the caller requested the rule-driven flow first.',core:'Not selected because the caller requested the rule-driven flow first. This does not establish whether core was enabled or ready.'},
  provider_unavailable:{legacy:'Not selected because the missing model runtime takes priority over the core/legacy choice.',core:'Not selected because no model runtime was available.'},
  flag_off:{deterministic:'Not selected: the caller did not request a deterministic path and a model runtime was available.',core:'Not selected because core execution was disabled.'},
  journey_disabled:{deterministic:'Not selected: the caller did not request a deterministic path and a model runtime was available.',core:'Not selected because this task type was not enabled for core execution.'},
  core_unavailable:{deterministic:'Not selected: the caller did not request a deterministic path and a model runtime was available.',core:'Not selected because core preparation failed. This reason does not identify which preparation check failed.'},
  core_selected:{deterministic:'Not selected: the caller did not request a deterministic path and a model runtime was available.',legacy:'Not selected because the enabled core path passed preparation.'},
 };
 return {title:titles[evidence.path]??evidence.path??'Path not captured',reason:reasons[evidence.reason]??'The capture does not include a recognized routing reason.',options:Object.entries(titles).map(([path,title])=>({path,title,selected:path===evidence.path,purpose:purposes[path],explanation:path===evidence.path?(reasons[evidence.reason]??'Selection recorded; its reason is not recognized.'):(explanations[evidence.reason]?.[path]??'Why this alternative was not selected was not captured.')}))};
}
