/** Exact semantic-contract evaluation, independent of heuristic confidence. */
import {isDeepStrictEqual} from 'node:util';
import {calibrationMetrics} from '../calibration.ts';
import type {resolve} from '../engine.ts';

type Result = ReturnType<typeof resolve>;
export function requestMeaning(result:Result) {
  return {
    status:result.status, intent:result.intent, entities:result.entities,
    requestedActions:result.requestedActions.map(({id, intent, items, after}) => ({id, intent, items, after:after ?? null})),
    operations:result.operations ?? [], references:result.references ?? [],
    issues:result.requestedActionIssues,
  };
}
export type RequestMeaning = ReturnType<typeof requestMeaning>;
const dimensions = ['status','intent','entities','requestedActions','operations','references','issues'] as const;

export function compareRequest(actual:RequestMeaning, expected:RequestMeaning) {
  // Missing labels must not silently count as a whole-request success.
  if (!expected || dimensions.some(key => !Object.hasOwn(expected, key)) ||
      Object.keys(expected).some(key => !(dimensions as readonly string[]).includes(key))) {
    throw new Error('A full request label must contain exactly all semantic dimensions');
  }
  const errors = dimensions.filter(key => !isDeepStrictEqual(actual[key], expected[key]));
  return {passed:errors.length === 0, errors};
}
export type RequestScore = ReturnType<typeof compareRequest> & {
  id:string; family:string; status:string; expectedStatus:string; confidence:number;
};
export function requestMetrics(rows:RequestScore[]) {
  if (!rows.length) throw new Error('Cannot evaluate an empty request corpus');
  const resolved = rows.filter(row => row.status === 'RESOLVED');
  const count = rows.length, passed = rows.filter(row => row.passed).length;
  return {
    count, passed, failed:count-passed, fullRequestExactMatch:passed/count,
    dimensionAccuracy:Object.fromEntries(dimensions.map(key => [key, rows.filter(row => !row.errors.includes(key)).length/count])),
    incorrectResolved:resolved.filter(row => !row.passed).length,
    falseResolved:rows.filter(row => row.status === 'RESOLVED' && row.expectedStatus !== 'RESOLVED').length,
    missedResolved:rows.filter(row => row.status !== 'RESOLVED' && row.expectedStatus === 'RESOLVED').length,
    abstained:rows.filter(row => row.status !== 'RESOLVED').length,
    // This measures confidence in the complete labelled meaning, not only intent.
    resolvedWholeRequestReliability:calibrationMetrics(resolved.map(row => ({confidence:row.confidence, correct:row.passed}))),
  };
}
