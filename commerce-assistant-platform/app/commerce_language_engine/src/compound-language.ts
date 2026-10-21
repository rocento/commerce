import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {tokenize, type Token} from './semantic-clauses.ts';
import {itemsFrom} from './semantic-entities.ts';
import {quantityPrefix} from './quantities.ts';
import {buildSemanticGraph} from './semantic-graph.ts';
import type {RequestedAction} from './intent-count.ts';
import type {Item, SemanticRequest} from './semantic-types.ts';

const destinations = ()=>recognitionMemo('compound-language.destinations',()=>(new Set(languageValue<string[]>('compound-language.destinations.value.1'))));
const connectors = ()=>recognitionMemo('compound-language.connectors',()=>(new Set(languageValue<string[]>('compound-language.connectors.value.1'))));
// These words carry request semantics. Require quotes when they belong to a
// merchant product name; never swallow an unparsed instruction as a product.
const reserved = ()=>recognitionMemo('compound-language.reserved',()=>(new Set((languageValue<string>('compound-language.reserved.value.1')
  + languageValue<string>('compound-language.reserved.value.2')
  + languageValue<string>('compound-language.reserved.value.3')
  + languageValue<string>('compound-language.reserved.value.4')
  + languageValue<string>('compound-language.reserved.value.5')).split(' '))));

function item(tokens: Token[], prior?: Item): Item | undefined {
  if (!tokens.length) return prior ? {...prior} : undefined;
  const words = tokens.map(t => t.quoted ? `"${t.value}"` : t.value);
  if (languageValue<string[]>('compound-language.item.value.1').includes(words[0])) return;
  const quantity = quantityPrefix(words);
  if (quantity.selection || quantity.quantityRange || quantity.quantity !== undefined
    && (!Number.isSafeInteger(quantity.quantity) || quantity.quantity < 1 || quantity.quantity > 1000000)) return;
  const body = tokens.slice(quantity.end);
  if (body.length === 1 && body[0].quoted && body[0].value.trim() && body[0].value.length <= 200) {
    return {productText: body[0].value, ...(quantity.quantity !== undefined ? {quantity: quantity.quantity} : {})};
  }
  if (body.length === 1 && !body[0].quoted && languageValue<string[]>('compound-language.item.value.2').includes(body[0].value)) {
    return prior ? {...prior, ...(quantity.quantity !== undefined ? {quantity: quantity.quantity} : {})} : undefined;
  }
  if (!body.length || body.some(t => !t.quoted && (reserved().has(t.value) || connectors().has(t.value)))) return;
  const parsed = itemsFrom(tokens);
  if (parsed.length !== 1 || !parsed[0].productText || parsed[0].productText.length > 200
    || parsed[0].reference || parsed[0].unit || parsed[0].selectionStrategy) return;
  return parsed[0];
}

function clause(tokens: Token[], prior?: Item): {intent: string; item: Item} | undefined {
  let remaining = tokens;
  const verb = !remaining[0]?.quoted && languageValue<string[]>('compound-language.verb.value.1').includes(remaining[0]?.value);
  if (verb) remaining = remaining.slice(1);
  else if (!prior) return;
  const destinationAt = (at: number) => {
    if (remaining[at]?.quoted || !languageValue<string[]>('compound-language.destinationAt.value.1').includes(remaining[at]?.value)) return;
    let end = at + 1;
    if (!remaining[end]?.quoted && languageValue<string[]>('compound-language.destinationAt.value.2').includes(remaining[end]?.value)) end++;
    const token = remaining[end];
    if (!token || token.quoted) return;
    // The reported typo is accepted only in the explicit leading add-to-card head.
    const destination = token.value === languageValue<string>('compound-language.destination.value.1') && at === 0 && tokens[0]?.value === languageValue<string>('compound-language.destination.value.2') ? 'cart' : token.value;
    if (destinations().has(destination)) return {destination, end: end + 1};
  };
  const matches = remaining.flatMap((_, i) => {
    const found = destinationAt(i);
    return found ? [{...found, start: i}] : [];
  });
  if (matches.length !== 1) return;
  const target = matches[0];
  if (target.start !== 0 && target.end !== remaining.length) return;
  const argument = target.start === 0 ? remaining.slice(target.end) : remaining.slice(0, target.start);
  const product = item(argument, prior);
  if (!product) return;
  return {intent: target.destination === languageValue<string>('compound-language.clause.value.1') ? 'ADD_TO_WISHLIST' : 'ADD_TO_CART', item: product};
}

/** A fully consumed two-action grammar, independent of diagnostic action counts.
 * Resolves linguistic meaning only; product identities and permissions belong to
 * the planner and commerce services. Context never supplies an omitted product.
 */
export function compoundRequest(text: string): (SemanticRequest & {requestedActions: RequestedAction[];clauseSourceText:string}) | undefined {
  if (text.length > 4000) return;
  const source = text.trim().replace(languagePattern('compound-language.source.pattern.1'), '').trim();
  const tokens = tokenize(source).map(t => ({...t, value: source.slice(t.start, t.end).toLowerCase().replace(languagePattern('compound-language.tokens.pattern.1'), '').replace(languagePattern('compound-language.tokens.pattern.2'), '-')}));
  // Tokenization is not consumption: reject ignored punctuation, unmatched quotes,
  // and symbols (for example a price or an extra slash-separated command).
  let end = 0;
  for (const token of tokens) {
    if (source.slice(end, token.start).trim()) return;
    end = token.end;
  }
  if (source.slice(end).trim()) return;
  let start = 0, stop = tokens.length;
  const word = (i: number) => tokens[i]?.quoted ? '' : tokens[i]?.value;
  if (languageValue<string[]>('compound-language.compoundRequest.value.1').includes(word(start))) start++;
  if (languageValue<string[]>('compound-language.compoundRequest.value.2').includes(word(start)) && word(start + 1) === languageValue<string>('compound-language.compoundRequest.value.3')) start += 2;
  if (languageValue<string[]>('compound-language.compoundRequest.value.4').includes(word(start))) start++;
  if (word(stop - 1) === languageValue<string>('compound-language.compoundRequest.value.5')) stop--;
  const breaks = tokens.flatMap((t, i) => i >= start && i < stop && !t.quoted && connectors().has(t.value) ? [i] : []);
  if (!breaks.length || breaks.some((p, i) => i > 0 && p !== breaks[i - 1] + 1)) return;
  const firstBreak = breaks[0], lastBreak = breaks.at(-1)!;
  const connector = tokens.slice(firstBreak, lastBreak + 1).map(t => t.value).join(' ');
  if (!languagePattern('compound-language.compoundRequest.pattern.1').test(connector)) return;
  const groups = [tokens.slice(start, firstBreak), tokens.slice(lastBreak + 1, stop)];
  const first = clause(groups[0]);
  if (!first) return;
  const second = clause(groups[1], first.item);
  if (!second || first.intent === second.intent) return;
  const entries = [first, second];
  const requestedActions: RequestedAction[] = entries.map((entry, i) => ({
    id: languageTemplate('compound-language.requestedActions.template.1', [i + 1]), intent: entry.intent,
    text: source.slice(groups[i][0].start, groups[i].at(-1)!.end), items: [entry.item],
    ...(i === 1 && connector.includes(languageValue<string>('compound-language.requestedActions.value.1')) ? languageValue<{ after: string; }>('compound-language.requestedActions.value.2') : {}),
  }));
  const clauses = requestedActions.map((action, i) => ({id: languageTemplate('compound-language.clauses.template.1', [i + 1]), text: action.text,
    start: groups[i][0].start, end: groups[i].at(-1)!.end, intent: action.intent, connector: i ? connector : 'start', negated: false}));
  const actions = requestedActions.map((action, i) => ({id: languageTemplate('compound-language.actions.template.1', [i + 1]), intent: action.intent,
    clauseId: clauses[i].id, operation: action.intent === 'ADD_TO_CART' ? 'ADD_ITEM' : 'SAVE_TO_WISHLIST', itemIndexes: [i]}));
  const items = entries.map(entry => entry.item);
  const relationships: SemanticRequest['relationships'] = actions.map((action, i) => ({from: action.id, relation: 'uses', to: languageTemplate('compound-language.relationships.template.1', [i + 1])}));
  if (requestedActions[1].after) relationships.push(languageValue<{ from: string; relation: "precedes"; to: string; }>('compound-language.compoundRequest.value.6'));
  const graph = buildSemanticGraph({primaryIntent: first.intent, clauses, actions, items, slots: [], references: [], relationships, compositionRules: []});
  return {status: 'RESOLVED', primaryIntent: first.intent, intents: entries.map(e => e.intent), entities: {items},
    requestedActions, clauseSourceText:source, operations: actions.map(a => a.operation), actions, clauses, references: [], relationships,
    slots: [], graph, ambiguities: [], missing: [], message: 'Both requested actions are understood. No changes have been made.'};
}
