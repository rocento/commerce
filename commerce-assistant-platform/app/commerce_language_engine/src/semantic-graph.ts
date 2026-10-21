import type {SemanticCompositionRule} from './types.ts';
import type {Action,Clause,Delivery,Item,Reference,Relationship,ResolvedAmbiguity,ResolvedSlot,SemanticGraph,SemanticGraphNode} from './semantic-types.ts';

export const MAX_SEMANTIC_GRAPH_NODES=256;
export const MAX_SEMANTIC_GRAPH_EDGES=512;
const safeValue=(value:unknown):unknown=>value===undefined?undefined:JSON.parse(JSON.stringify(value));

type GraphInput={primaryIntent:string;clauses:Clause[];actions:Action[];items:Item[];delivery?:Delivery;order?:{reference:string;resolvedReference?:string};slots:ResolvedSlot[];references:Reference[];relationships:Relationship[];ambiguities?:ResolvedAmbiguity[];compositionRules:SemanticCompositionRule[];compositionBySignature?:Map<string,SemanticCompositionRule[]>};
type Fact={from:string;to:string;relation:string};

/** Builds a bounded, deterministic request graph from already interpreted data. */
export function buildSemanticGraph(input:GraphInput):SemanticGraph {
 const nodes:SemanticGraphNode[]=[],edges:SemanticGraph['edges']=[],constraints:string[]=[];
 const byId=new Map<string,SemanticGraphNode>();let truncated=false;
 const addNode=(id:string,kind:string,value?:unknown,clauseId?:string):SemanticGraphNode|undefined=>{
  const existing=byId.get(id);if(existing)return existing;
  if(nodes.length>=MAX_SEMANTIC_GRAPH_NODES){truncated=true;return undefined;}
  const node={id,kind,...(clauseId?{clauseId}:{}),...(value!==undefined?{value:safeValue(value)}:{})};nodes.push(node);byId.set(id,node);return node;
 };
 const facts:Fact[]=[];
 const addFact=(from:string,to:string,relation:string)=>{if(facts.length>=MAX_SEMANTIC_GRAPH_EDGES*2){truncated=true;return;}facts.push({from,to,relation});};
 addNode('request','REQUEST');
 for(const clause of input.clauses)addNode(clause.id,'CLAUSE',{intent:clause.intent,connector:clause.connector,negated:clause.negated,text:clause.text});
 for(const action of input.actions){addNode(action.id,'ACTION',{intent:action.intent,operation:action.operation,itemIndexes:action.itemIndexes??[]},action.clauseId);if(byId.has(action.clauseId))addFact(action.clauseId,action.id,'performs');}
 for(let i=0;i<input.items.length;i++){
  const item=input.items[i],id=`item${i+1}`;addNode(id,'ITEM',item);
  if(item.quantity!==undefined){const quantityId=`quantity${i+1}`;addNode(quantityId,'QUANTITY',{value:item.quantity,...(item.unit?{unit:item.unit}:{})});constraints.push(quantityId);addFact(id,quantityId,'has_quantity');}
 }
 if(input.delivery){
  addNode('delivery','DELIVERY');
  if(input.delivery.addressReference){addNode('address','ADDRESS_REFERENCE',input.delivery.addressReference);addFact('delivery','address','has_address');}
  const date=input.delivery.date??input.delivery.relativeDate;
  if(date){addNode('delivery-date','DELIVERY_DATE',{value:date,timezone:input.delivery.timezone});constraints.push('delivery-date');addFact('delivery','delivery-date','has_date');}
  if(input.delivery.timeWindow){addNode('delivery-time','TIME_WINDOW',input.delivery.timeWindow);constraints.push('delivery-time');addFact('delivery','delivery-time','has_time_window');}
 }
 if(input.order){addNode('order','ORDER_REFERENCE',input.order);}
 if(input.references.some(reference=>reference.target==='request.items'||reference.target?.startsWith('result-set:'))||input.relationships.some(relationship=>relationship.to==='request.items'))addNode('result-set:request.items','RESULT_SET',{source:'request.items'});
 for(const slot of input.slots){
  const id=`slot:${slot.code}`;addNode(id,'SLOT',{code:slot.code,state:slot.state,requirement:slot.requirement,...(slot.value!==undefined?{value:slot.value}:{})});
  if(slot.state!=='RESOLVED')constraints.push(id);
  const action=input.actions.find(entry=>entry.intent===input.primaryIntent)??input.actions[0];
  if(action)addFact(action.id,id,'requires_slot');
 }
 for(let i=0;i<(input.ambiguities??[]).length;i++){
  const ambiguity=input.ambiguities![i]!,id=`ambiguity${i+1}`;addNode(id,'AMBIGUITY',{span:ambiguity.span,clarificationRequired:ambiguity.clarificationRequired});
  if(ambiguity.clarificationRequired)constraints.push(id);
  for(let j=0;j<ambiguity.candidates.length;j++){
   const candidate=ambiguity.candidates[j]!,candidateId=`${id}:candidate${j+1}`;
   addNode(candidateId,'AMBIGUITY_CANDIDATE',candidate);addFact(id,candidateId,'has_candidate');
  }
 }
 for(let i=0;i<input.references.length;i++){
  const reference=input.references[i],id=`reference${i+1}`;addNode(id,'REFERENCE',reference);
  const target=!reference.resolved?undefined:reference.target==='order'?'order':reference.target==='request.items'||reference.target==='result-set:request.items'?'result-set:request.items':reference.target?.startsWith('item')?reference.target:reference.kind==='address'?'address':reference.kind==='order'&&input.order?'order':undefined;
  if(target&&byId.has(target))addFact(id,target,'resolves_to');
 }
 for(const relationship of input.relationships){
  let from=relationship.from,to=relationship.to;
  if(from.startsWith('item'))from=from;
  if(to==='delivery'&&input.delivery)addNode('delivery','DELIVERY');
  if(to==='order'&&input.order)addNode('order','ORDER_REFERENCE',input.order);
  if(to==='request.items')to='result-set:request.items';
  if(byId.has(from)&&byId.has(to))addFact(from,to,relationship.relation);
 }
 const rulesBySignature=input.compositionBySignature;
 const rules=rulesBySignature?undefined:[...input.compositionRules].sort((a,b)=>a.precedence-b.precedence||a.code.localeCompare(b.code));
 const signatures=new Set<string>();
 for(const fact of facts){
  const left=byId.get(fact.from),right=byId.get(fact.to);if(!left||!right)continue;
  const signature=`${fact.from}|${fact.relation}|${fact.to}`;if(signatures.has(signature))continue;signatures.add(signature);
  const candidates=rulesBySignature?.get(`${left.kind}|${fact.relation}|${right.kind}`)??rules??[];
  const rule=candidates.find(candidate=>candidate.outputKind==='EDGE'&&(!candidate.leftRef||candidate.leftRef===left.id)&&(!candidate.rightRef||candidate.rightRef===right.id));
  const configured=rule?.outputTemplate.edgeRelation;
  const relation=typeof configured==='string'?configured:fact.relation.toUpperCase();
  if(edges.length>=MAX_SEMANTIC_GRAPH_EDGES){truncated=true;break;}
  edges.push({from:fact.from,to:fact.to,relation,...(rule?{ruleCode:rule.code}:{})});
 }
 return {nodes,edges,constraints:[...new Set(constraints)],truncated};
}
