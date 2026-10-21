/** Linguistic request data only. No IDs here grant commerce execution authority. */
export type Item = {productText?: string; quantity?: number; unit?: string; reference?: string; resolvedFrom?: string;selectionStrategy?:string};
export type Delivery = {addressReference?: string; date?: string; relativeDate?: string; timeWindow?: {period?: string; start?: string; end?: string}; timezone?: string};
export type PendingClarification = {text:string;intent:string;slot:'quantity'|'product'|'currency'};
export type SemanticContext = {
  /** Revalidated linguistic search text; never catalog identities or authority. */
  activeSearch?: {text:string;contextual?:true};
  pendingRequest?: string;
  pendingActionRequest?: string;
  /** A linguistic question only; its complete request is revalidated before a reply is used. */
  pendingClarification?: PendingClarification;
  selectedItems?: Item[];
  resultSetItems?: Item[];
  orderReference?: string;
  deliveryAddressReference?: string;
  industry?:string;
  referenceDate?: string;
  timezone?: string;
  previousIntent?:string|null;
  states?:string[];
};
export type RequestConstraint = {
  kind:'CONDITION'|'EXCLUSION';
  scope:'REQUEST'|'PRODUCT'|'UNIT_PRICE'|'LINE_TOTAL'|'BASKET_TOTAL'|'DELIVERY';
  operator:'IF'|'UNLESS'|'EXCLUDE';
  text:string;
  value:string;
  /** Unicode code-point offsets into interpretationText, or text when not edited. */
  start:number;
  end:number;
  state:'UNSUPPORTED';
};
/** UTF-16 start/end offsets into the containing resolution clauseSourceText. */
export type Clause = {id: string; text: string; start: number; end: number; intent: string; connector: string; negated: boolean};
export type Action = {id: string; intent: string; clauseId: string; operation: string; itemIndexes?: number[]};
export type Reference = {expression: string; kind: 'product'|'order'|'address'|'result_set'|'action'; resolved: boolean; target?: string;state?:SlotState;selectionStrategy?:string;candidates?:unknown[]};
export type Relationship = {from: string; relation: 'uses'|'precedes'|'modifies'|'refers_to'; to: string};
export type SemanticGraphNode={id:string;kind:string;clauseId?:string;value?:unknown};
export type SemanticGraphEdge={from:string;to:string;relation:string;ruleCode?:string};
export type SemanticGraph={nodes:SemanticGraphNode[];edges:SemanticGraphEdge[];constraints:string[];truncated:boolean};
export type AmbiguityCandidate={kind:string;value:string;industry?:string;score:number};
export type ResolvedAmbiguity={span:string;candidates:AmbiguityCandidate[];clarificationRequired:boolean};
export type SlotState = 'RESOLVED'|'MISSING'|'AMBIGUOUS'|'INVALID'|'REFERENCE_PENDING'|'AUTHORITY_LOOKUP_REQUIRED'|'UNSUPPORTED';
export type ResolvedSlot = {code:string;state:SlotState;requirement:string;source?:string;value?:unknown;candidates:unknown[];confidence:number;requiresAuthorizationLookup:boolean};
export type SemanticRequest = {
  status: 'RESOLVED'|'NEEDS_CONTEXT'|'AMBIGUOUS';
  primaryIntent: string;
  intents: string[];
  entities: {items: Item[]; delivery?: Delivery; order?: {reference: string; resolvedReference?: string; requiresAuthorizationLookup?: boolean}};
  operations: string[];
  actions: Action[];
  clauses: Clause[];
  references: Reference[];
  relationships: Relationship[];
  slots: ResolvedSlot[];
  missing: string[];
  message: string;
  clarificationQuestion?: string;
  graph: SemanticGraph;
  ambiguities:ResolvedAmbiguity[];
};
