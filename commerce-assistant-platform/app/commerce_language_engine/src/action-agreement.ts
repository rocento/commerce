import type {IntentCount} from './intent-count.ts';

type Interpretation = {
  status: string;
  intent: string | null;
  primaryIntent?: string | null;
  requestType?: string;
  clauses?: {intent: string; negated: boolean}[];
};

/** Customer clauses, not preparation operations, must agree with the final list.
 * This check can hold a request for review; it can never authorize an action.
 */
export function actionInterpretationConflicts(result: Interpretation, count: IntentCount): boolean {
  if (count.intentCountStatus !== 'EXACT' || result.status !== 'RESOLVED') return false;
  if (!result.requestType && count.requestedActions.length === 1 && count.requestedActions[0].intent === result.intent) return false;
  const legacy = result.clauses?.length
    ? result.clauses.filter(clause => !clause.negated).map(clause => clause.intent)
    : result.primaryIntent || result.intent ? [result.primaryIntent ?? result.intent!] : [];
  const requested = count.requestedActions.map(action => action.intent);
  // Preserve both order and multiplicity: two cart adds cannot collapse into one.
  return JSON.stringify(legacy) !== JSON.stringify(requested);
}
