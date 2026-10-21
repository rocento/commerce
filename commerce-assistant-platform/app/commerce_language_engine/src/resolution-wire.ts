import {withDictionaryRecognition} from './recognition-rules.ts';
import {readFileSync} from 'node:fs';
import type {Dictionary} from './types.ts';
import {runtimeSha256} from './runtime-identity.ts';
import type {ResolutionEnvelope, ResolutionProvenance, ResolutionV2} from './generated/language-resolution-types.ts';

type Schema = boolean | {[key: string]: any};
const schema = JSON.parse(readFileSync(new URL('./generated/language-resolution.schema.json', import.meta.url), 'utf8'));
// Fail startup if generation introduces a constraint this validator cannot enforce.
const supportedKeywords = new Set([
  '$defs', '$id', '$ref', '$schema', 'title', 'description', 'default',
  'anyOf', 'allOf', 'const', 'enum', 'type', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'items', 'minItems', 'maxItems', 'properties', 'required',
  'additionalProperties', 'minProperties', 'maxProperties',
]);
function checkSchema(rule: Schema): void {
  if (typeof rule === 'boolean') return;
  for (const key of Object.keys(rule)) {
    if (!supportedKeywords.has(key)) throw new Error('Unsupported wire schema keyword: ' + key);
  }
  for (const map of [rule.$defs, rule.properties]) {
    for (const child of Object.values(map ?? {})) checkSchema(child as Schema);
  }
  for (const child of [...(rule.anyOf ?? []), ...(rule.allOf ?? [])]) checkSchema(child);
  for (const child of [rule.items, rule.additionalProperties]) if (child !== undefined) checkSchema(child);
  if (rule.type !== undefined && !['null', 'boolean', 'string', 'number', 'integer', 'array', 'object'].includes(rule.type)) {
    throw new Error('Unsupported wire schema type');
  }
  if (rule.$ref && (!rule.$ref.startsWith('#/$defs/') || !schema.$defs[rule.$ref.slice(8)])) {
    throw new Error('Unknown wire schema reference');
  }
}
checkSchema(schema);
const resultFields = new Set(Object.keys(schema.$defs.ResolutionV2.properties));
// Existing explanatory/legacy projections are retained for inspection, but they
// cannot become execution inputs. A new parser field requires explicit review.
const diagnosticFields = new Set([
  'text', 'normalizedText', 'matchedSemanticGroups', 'evidence', 'negativeEvidence',
  'alternatives', 'debug', 'latencyMs', 'fulfillment', 'requestedIntents', 'intents',
  'clarificationQuestion', 'contextRequest', 'correctionEvidence',
  'product_meaning', 'product_meanings',
]);

/** Validate the generated, closed wire schema before exposing parser results.
 * This interpreter supports the JSON Schema constructs emitted by our generator;
 * Python independently validates cross-field semantics and commerce admission.
 */
function valid(rule: Schema, value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof rule === 'boolean') return rule;
  if (rule.$ref) {
    if (!rule.$ref.startsWith('#/$defs/')) throw new Error('Nonlocal wire schema reference');
    if (!valid(schema.$defs[rule.$ref.slice(8)], value, depth + 1)) return false;
  }
  if (rule.anyOf && !rule.anyOf.some((part: Schema) => valid(part, value, depth + 1))) return false;
  if (rule.allOf && !rule.allOf.every((part: Schema) => valid(part, value, depth + 1))) return false;
  if ('const' in rule && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (rule.type === 'null') return value === null;
  if (rule.type === 'boolean' && typeof value !== 'boolean') return false;
  if (rule.type === 'string') {
    if (typeof value !== 'string') return false;
    const length = [...value].length;
    if (rule.minLength !== undefined && length < rule.minLength || rule.maxLength !== undefined && length > rule.maxLength) return false;
    if (rule.pattern && !new RegExp(rule.pattern, 'u').test(value)) return false;
  }
  if (rule.type === 'number' || rule.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || rule.type === 'integer' && !Number.isSafeInteger(value)) return false;
    if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum) return false;
    if (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum || rule.exclusiveMaximum !== undefined && value >= rule.exclusiveMaximum) return false;
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value)) return false;
    if (rule.minItems !== undefined && value.length < rule.minItems || rule.maxItems !== undefined && value.length > rule.maxItems) return false;
    if (rule.items && !value.every(item => valid(rule.items, item, depth + 1))) return false;
  }
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>, properties = rule.properties ?? {}, keys = Object.keys(object);
    if (rule.minProperties !== undefined && keys.length < rule.minProperties || rule.maxProperties !== undefined && keys.length > rule.maxProperties) return false;
    if (rule.required?.some((key: string) => !Object.hasOwn(object, key))) return false;
    for (const key of keys) {
      if (Object.hasOwn(properties, key)) { if (!valid(properties[key], object[key], depth + 1)) return false; }
      else if (rule.additionalProperties === false || typeof rule.additionalProperties === 'object' && !valid(rule.additionalProperties, object[key], depth + 1)) return false;
    }
  }
  return true;
}

export function validateResolutionEnvelope(value: unknown): asserts value is ResolutionEnvelope {
  if (!valid(schema, value)) throw new Error('Invalid language resolution wire response');
  assertResolutionSemantics((value as ResolutionEnvelope).result);
}

/** Catch inconsistent producer graphs before Python's independent validation. */
export function assertResolutionSemantics(result: ResolutionV2): void {
  const fail = (message: string): never => { throw new Error('Invalid language resolution semantics: ' + message); };
  const clauses = new Set((result.clauses ?? []).map(clause => clause.id));
  const actions = new Set((result.actions ?? []).map(action => action.id));
  if (clauses.size !== (result.clauses ?? []).length || actions.size !== (result.actions ?? []).length || [...clauses].some(id => actions.has(id))) fail('duplicate IDs');
  const items = result.entities?.items ?? [];
  if (!Array.isArray(items) || items.length > 51) fail('invalid items');
  const itemCount = (items as unknown[]).length;
  for (const clause of result.clauses ?? []) {
    if (clause.end < clause.start) fail('reversed clause span');
    if (result.clauseSourceText == null || clause.end > result.clauseSourceText.length || result.clauseSourceText.slice(clause.start, clause.end) !== clause.text) fail('clause span does not match its source');
  }
  for (const action of result.actions ?? []) {
    if (!clauses.has(action.clauseId)) fail('unknown action clause');
    const indexes = action.itemIndexes ?? [];
    if (new Set(indexes).size !== indexes.length || indexes.some(index => index < 0 || index >= itemCount)) fail('invalid action item index');
  }
  const targets = new Set([...clauses, ...actions, 'request', 'request.items', ...Array.from({length: itemCount}, (_, i) => `item${i + 1}`)]);
  const itemIds = new Set(Array.from({length: itemCount}, (_, i) => `item${i + 1}`));
  for (const reference of result.references ?? []) {
    if (!reference.resolved) continue;
    if (reference.kind === 'product' && !itemIds.has(reference.target ?? '')) fail('unknown reference item');
    if (reference.kind === 'action' && !actions.has(reference.target ?? '')) fail('unknown reference action');
  }
  for (const key of ['delivery', 'order']) if (Object.hasOwn(result.entities ?? {}, key)) targets.add(key);
  for (const link of result.relationships ?? []) {
    if (!targets.has(link.from) || !targets.has(link.to)) fail('unknown relationship endpoint');
    if (link.relation === 'precedes' && (!actions.has(link.from) || !actions.has(link.to) || link.from === link.to)) fail('invalid precedence');
  }
  const slots = result.slots ?? [];
  if (new Set(slots.map(slot => slot.code)).size !== slots.length) fail('duplicate slot codes');
  if (result.graph) {
    const nodes = new Set(result.graph.nodes.map(node => node.id));
    if (nodes.size !== result.graph.nodes.length) fail('duplicate graph nodes');
    for (const edge of result.graph.edges) if (!nodes.has(edge.from) || !nodes.has(edge.to)) fail('unknown graph endpoint');
    for (const constraint of result.graph.constraints) if (!nodes.has(constraint)) fail('unknown graph constraint');
    for (const node of result.graph.nodes) if (node.clauseId != null && !nodes.has(node.clauseId)) fail('unknown graph clause');
  }
  const metadata = ['requestedActionsVersion', 'intentCount', 'uniqueIntentCount', 'intentCountStatus', 'requestedActions', 'requestedActionIssues'] as const;
  const present = metadata.filter(key => Object.hasOwn(result, key));
  if (present.length) {
    if (present.length !== metadata.length || result.requestedActionsVersion !== 1) fail('incomplete requested-action metadata');
    const requested = result.requestedActions, issues = result.requestedActionIssues;
    if (!requested || !issues || new Set(issues).size !== issues.length) fail('invalid requested-action metadata');
    const seen = new Set<string>();
    for (const action of requested!) {
      if (seen.has(action.id) || action.after != null && !seen.has(action.after)) fail('invalid requested-action dependency');
      seen.add(action.id);
      for (const item of action.items) if (!item.productText?.trim() && !item.reference) fail('requested item needs a description or reference');
    }
    if (result.intentCountStatus === 'EXACT') {
      if (result.intentCount !== requested!.length || result.uniqueIntentCount !== new Set(requested!.map(action => action.intent)).size) fail('requested-action count mismatch');
      if (issues!.some(issue => issue !== 'INTERPRETATION_CONFLICT')) fail('exact requested-actions have unresolved issues');
    } else if (result.intentCountStatus === 'NEEDS_CLARIFICATION') {
      if (result.intentCount !== null || result.uniqueIntentCount !== null || !issues!.length) fail('uncertain requested-actions need null counts and issues');
    } else fail('missing requested-action count status');
  }
  if (result.compoundInterpretationVersion != null && result.requestedActionsVersion == null) fail('compound interpretation needs requested-action metadata');
}

export function resolutionEnvelope(result: Record<string, unknown>, provenance: ResolutionProvenance): ResolutionEnvelope {
  const semantics: Record<string, unknown> = {}, diagnostics: Record<string, unknown> = {};
  // JSON encoding removes optional undefined fields exactly as the HTTP path does.
  for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(result)))) {
    if (!resultFields.has(key) && !diagnosticFields.has(key)) throw new Error('Unclassified language response field: ' + key);
    (resultFields.has(key) ? semantics : diagnostics)[key] = value;
  }
  const envelope: unknown = {contractVersion: 2, provenance, result: semantics, diagnostics};
  validateResolutionEnvelope(envelope);
  return envelope;
}

export async function loadResolutionProvenance(dictionary: Dictionary): Promise<ResolutionProvenance> {
 return withDictionaryRecognition(dictionary,async ()=>{
  const provenance = {
    releaseId: process.env.CLE_RUNTIME_RELEASE_ID ?? null,
    generationFingerprint: dictionary.generationFingerprint,
    runtimeVersion: await runtimeSha256(),
    normalizationVersion: 'english-v1',
    clauseSpanEncoding: 'utf-16-code-units',
    evidenceSpanEncoding: 'unicode-code-points',
  };
  if (!valid(schema.$defs.ResolutionProvenance, provenance)) throw new Error('Invalid language runtime identity');
  return provenance as ResolutionProvenance;

 });
}
