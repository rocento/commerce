import {withDictionaryRecognition} from './recognition-rules.ts';
import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {conversationIntent} from './conversation.ts';
import {canonicalRead} from './read-language.ts';
import {governedRequest} from './governed-read-language.ts';
import {parseRequest} from './request-parser.ts';
import {normalize} from './normalize.ts';
import {commerceFragment} from './commerce-fragments.ts';
import {clearCartRequested} from './cart-clear-language.ts';
import {clearComparisonRequested} from './comparison-language.ts';
import {wishlistReadOrCommand} from './wishlist-language.ts';
import {affirmativeWrapperEnd, clauses, hasUnparsedSentenceAction, tokenize} from './semantic-clauses.ts';
import {itemsFrom} from './semantic-entities.ts';
import type {Dictionary} from './types.ts';
import type {Item, SemanticContext} from './semantic-types.ts';

export type RequestedAction = {
  id: string;
  intent: string;
  text: string;
  items: Item[];
  /** Customer sequencing only; this is not an executable plan. */
  after?: string;
};
export type RequestedActionIssue = 'UNRESOLVED_REQUEST' | 'UNRESOLVED_PRODUCT' | 'INVALID_QUANTITY' | 'ALTERNATIVE_ACTIONS' | 'CONDITIONAL_REQUEST' | 'REQUEST_LIMIT' | 'INTERPRETATION_CONFLICT';
export type IntentCount = {
  requestedActionsVersion: 1;
  requestedActionIssues: RequestedActionIssue[];
  intentCount: number | null;
  uniqueIntentCount: number | null;
  intentCountStatus: 'EXACT' | 'NEEDS_CLARIFICATION';
  requestedActions: RequestedAction[];
};
type Interpretation = {
  status: string;
  intent: string | null;
  primaryIntent?: string | null;
  entities: Record<string, any>;
  clauses?: {id: string; intent: string; negated: boolean; text: string}[];
  actions?: {clauseId: string; itemIndexes?: number[]}[];
};
type Head = {intent: string; end: number; collection?: boolean};
const joiners = ()=>recognitionMemo('intent-count.joiners',()=>(new Set(languageValue<string[]>('intent-count.joiners.value.1'))));
const modifiers = ()=>recognitionMemo('intent-count.modifiers',()=>(new Set(languageValue<string[]>('intent-count.modifiers.value.1'))));
const destinations = ()=>recognitionMemo('intent-count.destinations',()=>(new Set(languageValue<string[]>('intent-count.destinations.value.1'))));

/** Count linguistic requests, never preparation operations or commerce writes. */
export function countIntents(dictionary: Dictionary, text: string, context: SemanticContext, result: Interpretation): IntentCount {
 return withDictionaryRecognition(dictionary,()=>{
  const unknown = (actions: RequestedAction[] = [], issues: RequestedActionIssue[] = ['UNRESOLVED_REQUEST']): IntentCount => ({requestedActionsVersion: 1, requestedActionIssues: [...new Set(issues)], intentCount: null, uniqueIntentCount: null, intentCountStatus: 'NEEDS_CLARIFICATION', requestedActions: actions});
  const finish = (actions: RequestedAction[], issues: RequestedActionIssue[] = []): IntentCount => {
    if (actions.length > 32 || actions.some(action => action.items.length > 50)) return unknown([], ['REQUEST_LIMIT']);
    const bounded = actions.map(action => ({...action, items: action.items.map(item => {
      const {quantity, ...rest} = item;
      if (quantity !== undefined && (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1000000)) {
        issues.push('INVALID_QUANTITY');
        return rest;
      }
      return item;
    })}));
    if (issues.length) return unknown(bounded, issues);
    return {requestedActionsVersion: 1, requestedActionIssues: [], intentCount: bounded.length, uniqueIntentCount: new Set(bounded.map(a => a.intent)).size, intentCountStatus: 'EXACT', requestedActions: bounded};
  };
  const exact = (actions: RequestedAction[]): IntentCount => finish(actions);
  if (text.length > 4000) return unknown([], ['REQUEST_LIMIT']);
  const resultItems = (): Item[] => result.entities.items ?? (result.entities.productText ? [{productText: result.entities.productText, ...(result.entities.quantity !== undefined ? {quantity: result.entities.quantity} : {})}] : []);
  // Whole-request domain recognizers own transfers, aliases and nonliteral intent.
  // Do not split their internal wording into unrelated customer mutations.
  const normalizedTokens=normalize(text).split(' ').filter(Boolean);
  const completeFrame=parseRequest(normalizedTokens,dictionary).filter(frame=>!frame.negated&&!frame.instructional&&!frame.excludedObject&&normalizedTokens.slice(0,frame.start).every(token=>languageValue<string[]>('intent-count.completeFrame.value.1').includes(token))&&frame.end===normalizedTokens.length);
  const domainOwned = conversationIntent(text) || canonicalRead(text) || governedRequest(dictionary,text)?.intent===result.intent || commerceFragment(dictionary, text)
    || clearCartRequested(text) || clearComparisonRequested(text) || wishlistReadOrCommand(text)?.canonical
    || completeFrame.length===1&&completeFrame[0].intent===result.intent&&!normalizedTokens.includes(languageValue<string>('intent-count.domainOwned.value.1'))&&!languageValue<string[]>('intent-count.domainOwned.value.2').includes(normalizedTokens[0])
    || result.entities.sourceCollection && ['CART_MOVE_FROM_WISHLIST', 'CART_MOVE_TO_WISHLIST'].includes(result.intent ?? '');
  if (result.status === 'RESOLVED' && result.intent && domainOwned) return exact([{id: 'request1', intent: result.intent, text, items: resultItems()}]);
  const tokens = tokenize(text);
  // Quoted/instructional examples must not become customer commands.
  if (languagePattern('intent-count.countIntents.pattern.1').test(text)) return unknown();
  if (tokens.length && tokens.every(t => t.quoted)) return unknown();
  if (languagePattern('intent-count.countIntents.pattern.2').test(text)) return unknown();
  const existing = clauses(text, dictionary);
  if (hasUnparsedSentenceAction(text, dictionary, existing)) return unknown();
  function head(p: number, inherited?: string, itemEllipsis = false): Head | undefined {
    if (!tokens[p] || tokens[p].quoted) return;
    const word = tokens[p].value;
    let q = p;
    const add = languageValue<string[]>('intent-count.add.value.1').includes(word);
    const remove = languageValue<string[]>('intent-count.remove.value.1').includes(word);
    // Correct only the explicit add-to-cart command head, never a product name.
    if (add && tokens[p + 1]?.value === languageValue<string>('intent-count.head.value.1') && tokens[p + 2]?.value === languageValue<string>('intent-count.head.value.2') && !tokens[p + 2].quoted) tokens[p + 2] = {...tokens[p + 2], value: 'cart'};
    if (!add && !remove) {
      const read = tokens.slice(p).map(t => t.value).join(' ').match(languagePattern('intent-count.read.pattern.1'));
      if (read) return {intent: read[1] === languageValue<string>('intent-count.canonical.value.1') ? 'VIEW_WISHLIST' : 'VIEW_CART', end: p + read[0].split(' ').length};
      const known = existing.find(c => c.start === tokens[p].start);
      if (known) return {intent: known.intent, end: p + 1};
      if (inherited?.startsWith('VIEW_') && destinations().has(word)) return {intent: word === languageValue<string>('intent-count.head.value.3') ? 'VIEW_WISHLIST' : 'VIEW_CART', end: p + 1};
      if (!inherited?.match(languagePattern('intent-count.head.pattern.1')) || !itemEllipsis && !languageValue<string[]>('intent-count.head.value.4').includes(word)) return;
    } else q++;
    const limit = tokens.findIndex((t, i) => i > q && !t.quoted && joiners().has(t.value));
    const end = limit < 0 ? tokens.length : limit;
    let destination: string | undefined;
    for (let i = q; i < end; i++) {
      if (tokens[i].quoted) continue;
      if (destinations().has(tokens[i].value) && (i === q || languageValue<string[]>('intent-count.head.value.5').includes(tokens[i - 1]?.value))) destination = tokens[i].value;
    }
    if (!add && !remove && !destination) return;
    const wishlist = destination === 'wishlist';
    return {intent: destination ? (remove || !add && inherited?.startsWith('REMOVE_FROM_') ? 'REMOVE_FROM_' : 'ADD_TO_') + (wishlist ? 'WISHLIST' : 'CART') : remove ? 'REMOVE_FROM_CART' : 'ADD_TO_CART', end: add || remove ? p + 1 : p, collection: true};
  }
  type Part = {start: number; end: number; head: Head; negated: boolean; correction: boolean; alternative: boolean; then: boolean};
  const parts: Part[] = [];
  function start(at: number, connector: string): number | undefined {
    let p = at;
    let correction = languageValue<string[]>('intent-count.correction.value.1').includes(connector);
    let then = connector === languageValue<string>('intent-count.lexical.value.3');
    while (modifiers().has(tokens[p]?.value)) {correction ||= languageValue<string[]>('intent-count.start.value.1').includes(tokens[p].value); then ||= tokens[p].value === languageValue<string>('intent-count.start.value.2'); p++;}
    p = affirmativeWrapperEnd(tokens, p);
    while (languageValue<string[]>('intent-count.start.value.3').includes(tokens[p]?.value)) p++;
    let negated = false;
    if (tokens[p]?.value === languageValue<string>('intent-count.start.value.4') && tokens[p + 1]?.value === languageValue<string>('intent-count.start.value.5')) {negated = true; p += 2;}
    if (languageValue<string[]>('intent-count.start.value.6').includes(tokens[p]?.value)) {negated = true; p++;}
    const prior = parts.at(-1);
    const itemEllipsis = !!prior && tokens.slice(prior.start, at - 1).some(t => !t.quoted && destinations().has(t.value));
    const h = head(p, prior?.head.intent, itemEllipsis);
    if (!h) return;
    if (parts.length) parts.at(-1)!.end = at - 1;
    parts.push({start: p, end: tokens.length, head: h, negated, correction, alternative: connector === languageValue<string>('intent-count.lexical.value.4'), then});
    return p;
  }
  let first = 0;
  while (languageValue<string[]>('intent-count.countIntents.value.1').includes(tokens[first]?.value)) first++;
  start(first, 'start');
  for (let p = first + 1; p < tokens.length; p++) {
    if (!tokens[p].quoted && joiners().has(tokens[p].value)) {
      const next = start(p + 1, tokens[p].value);
      if (next !== undefined) p = next;
    }
    if (parts.length > 32) return unknown([], ['REQUEST_LIMIT']);
  }
  if (!parts.length) {
    const intent = result.intent ?? result.primaryIntent;
    if (result.status !== 'RESOLVED' || !intent) return unknown();
    // Whole-request domain parsers own transfers, conversational requests and reads.
    return exact([{id: 'request1', intent, text, items: resultItems()}]);
  }
  if (parts[0].start > first + 2) return unknown();
  // Existing whole-request parsers own non-collection objects and aliases,
  // such as applying coupons or saving a product for later.
  if (parts.length === 1 && parts[0].head.collection && !parts[0].negated && !tokens.some(t => !t.quoted && destinations().has(t.value))) {
    if (result.status !== 'RESOLVED' || !result.intent) return unknown();
    return exact([{id: 'request1', intent: result.intent, text, items: resultItems()}]);
  }
  const actions: RequestedAction[] = [];
  let uncertain = false;
  const unresolvedActions: boolean[] = [];
  let priorItems: Item[] = [];
  for (const part of parts) {
    let end = part.end;
    while (end > part.start && joiners().has(tokens[end - 1]?.value)) end--;
    const segment = tokens.slice(part.start, end);
    const raw = text.slice(tokens[part.start].start, tokens[end - 1]?.end);
    uncertain ||= part.alternative;
    let unresolved = false;
    let items: Item[] = [];
    if (part.head.collection) {
      // A destination after a product list applies to the complete action.
      const destination = segment.findLast((t, i) => !t.quoted && destinations().has(t.value) && languageValue<string[]>('intent-count.destination.value.1').includes(segment[i - 1]?.value));
      const namedDestinations = segment.filter((t, i) => !t.quoted && destinations().has(t.value) && languageValue<string[]>('intent-count.namedDestinations.value.1').includes(segment[i - 1]?.value));
      if (new Set(namedDestinations.map(t => t.value === languageValue<string>('intent-count.countIntents.value.2') ? 'cart' : t.value)).size > 1) unresolved = true;
      if (destination) part.head.intent = (part.head.intent.startsWith('REMOVE_FROM_') ? 'REMOVE_FROM_' : 'ADD_TO_') + (destination.value === languageValue<string>('intent-count.countIntents.value.3') ? 'WISHLIST' : 'CART');
      let argument = tokens.slice(part.head.end, end);
      // Both "add banana to cart" and "add to cart 1 banana" are accepted.
      if (languageValue<string[]>('intent-count.countIntents.value.4').includes(argument[0]?.value)) argument = argument.slice(1);
      if (languageValue<string[]>('intent-count.countIntents.value.5').includes(argument[0]?.value) && destinations().has(argument[1]?.value)) argument = argument.slice(1);
      if (destinations().has(argument[0]?.value)) argument = argument.slice(1);
      while (argument.length && languageValue<string[]>('intent-count.countIntents.value.6').includes(argument.at(-1)!.value)) argument = argument.slice(0, -1);
      items = itemsFrom(argument);
      if (!items.length) items = priorItems.map(item => ({...item}));
      items = items.flatMap(item => {
        if (!item.reference) return [item];
        const candidates = priorItems.length ? priorItems : context.selectedItems ?? [];
        if (languagePattern('intent-count.countIntents.pattern.3').test(item.reference) && candidates.length && (candidates.length === 1 || languagePattern('intent-count.countIntents.pattern.4').test(item.reference))) return candidates.map(candidate => ({...candidate, ...(item.quantity !== undefined ? {quantity: item.quantity} : {})}));
        return [item];
      });
      if (!part.negated) unresolved ||= !items.length || items.some(item => !item.productText || item.reference || item.quantity !== undefined && (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 1000000));
      // Unparsed action tails and alternatives are not silently counted as products.
      if (!part.negated) unresolved ||= segment.some(t => !t.quoted && languageValue<string[]>('intent-count.countIntents.value.7').includes(t.value));
    } else {
      const matched = result.clauses?.find(c => c.intent === part.head.intent && !c.negated && raw.startsWith(c.text));
      if (matched) items = (result.actions ?? []).filter(a => a.clauseId === matched.id).flatMap(a => (a.itemIndexes ?? []).map(i => result.entities.items?.[i]).filter((item): item is Item => !!item));
      if (!matched && !['VIEW_CART', 'VIEW_WISHLIST'].includes(part.head.intent) && result.status !== 'RESOLVED') unresolved = true;
      if (['VIEW_CART', 'VIEW_WISHLIST'].includes(part.head.intent) && tokens.slice(part.head.end, end).some(t => !languageValue<string[]>('intent-count.countIntents.value.8').includes(t.value))) unresolved = true;
    }
    if (items.length) priorItems = items;
    if (part.negated) continue;
    unresolved ||= segment.some(t => !t.quoted && languageValue<string[]>('intent-count.countIntents.value.9').includes(t.value));
    if (part.correction || segment.at(-1)?.value === languageValue<string>('intent-count.countIntents.value.10')) {actions.pop(); unresolvedActions.pop();}
    unresolvedActions.push(unresolved);
    const previous = actions.at(-1);
    actions.push({id: languageTemplate('intent-count.countIntents.template.1', [actions.length + 1]), intent: part.head.intent, text: raw, items, ...(part.then && previous ? {after: previous.id} : {})});
  }
  // Legacy scoring can call two distinct collection destinations ambiguous;
  // an explicit parsed pair still has an exact descriptive count.
  if (result.status === 'DENIED' || result.status === 'AMBIGUOUS' && parts.some(p => !p.head.collection)) uncertain = true;
  if (tokens.some(t => !t.quoted && languageValue<string[]>('intent-count.countIntents.value.11').includes(t.value))) uncertain = true;
  const issues: RequestedActionIssue[] = [];
  if (parts.some(part => part.alternative)) issues.push('ALTERNATIVE_ACTIONS');
  if (tokens.some(t => !t.quoted && languageValue<string[]>('intent-count.countIntents.value.12').includes(t.value))) issues.push('CONDITIONAL_REQUEST');
  if (actions.some(action => action.items.some(item => !item.productText || item.reference && item.reference !== 'QUANTITY_CHOICE'))) issues.push('UNRESOLVED_PRODUCT');
  if (actions.some(action => action.items.some(item => item.reference === 'QUANTITY_CHOICE'))) issues.push('INVALID_QUANTITY');
  if ((uncertain || unresolvedActions.some(Boolean)) && !issues.length) issues.push('UNRESOLVED_REQUEST');
  return finish(actions, issues);

 });
}
