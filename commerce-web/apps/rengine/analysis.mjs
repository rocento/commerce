/** Presentation projections of real observations. No invented rule hits or stage timings. */
export function languageFlow(envelope) {
  const result = envelope.result ?? envelope;
  const diagnostic = envelope.diagnostics ?? envelope;
  const debug = diagnostic.debug ?? {};
  const actions = result.requestedActions ?? result.actions ?? [];
  return [
    { id: 'input', title: 'Input & context', subtitle: 'Request boundary', data: { text: diagnostic.text, context: result.context?.input } },
    { id: 'normalize', title: 'Normalization', subtitle: diagnostic.normalizedText ?? 'Not exposed', data: { normalizedText: diagnostic.normalizedText, tokens: debug.tokens, corrections: debug.searchCorrections, correctionEvidence: diagnostic.correctionEvidence } },
    { id: 'match', title: 'Semantic matches', subtitle: `${diagnostic.matchedSemanticGroups?.length ?? 0} groups`, data: { groups: diagnostic.matchedSemanticGroups, phrases: debug.matchedPhrases, negativeEvidence: diagnostic.negativeEvidence } },
    { id: 'score', title: 'Rules & ranking', subtitle: `${debug.candidates?.length ?? 0} candidates`, data: { candidates: debug.candidates, evidence: diagnostic.evidence, alternatives: diagnostic.alternatives, actionFrames: debug.actionFrames, contextualFrames: debug.contextualFrames } },
    { id: 'compose', title: 'Action graph', subtitle: `${actions.length} requested actions`, data: { clauses: result.clauses, actions, relationships: result.relationships, graph: result.graph, entities: result.entities, references: result.references, slots: result.slots } },
    { id: 'decision', title: 'Resolution', subtitle: result.status ?? 'Unknown', data: { status: result.status, intent: result.intent, confidence: result.confidence, message: result.message, requiresConfirmation: result.requiresConfirmation, missing: result.missing, context: result.context?.next } },
  ];
}
export function percentile(values, percent) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percent / 100 * sorted.length) - 1)];
}
export function summary(rows, elapsedMs) {
  const successful = rows.filter(row => row.ok);
  const durations = successful.map(row => row.elapsedMs);
  const checked = rows.filter(row => typeof row.matched === 'boolean');
  return {
    requests: rows.length, succeeded: successful.length, failed: rows.length - successful.length,
    resolved: successful.filter(row => row.status === 'RESOLVED').length,
    evaluated: checked.length, passed: checked.filter(row => row.matched).length,
    accuracy: checked.length ? checked.filter(row => row.matched).length / checked.length : null,
    p50Ms: percentile(durations, 50), p95Ms: percentile(durations, 95), p99Ms: percentile(durations, 99),
    minMs: durations.length ? Math.min(...durations) : null, maxMs: durations.length ? Math.max(...durations) : null,
    elapsedMs, requestsPerSecond: elapsedMs > 0 ? rows.length / (elapsedMs / 1000) : 0,
  };
}
export function parseSSEFrame(frame) {
  let type = 'message'; const data = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try { return { type, data: JSON.parse(data.join('\n')) }; }
  catch { throw new Error('Invalid assistant event payload'); }
}
