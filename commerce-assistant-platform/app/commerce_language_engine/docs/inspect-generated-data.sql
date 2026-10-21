-- Run in DBeaver against commerce_language. All queries are read-only.
SELECT dictionary_version, fingerprint, created_at, active,
       manifest->'counts' AS counts
FROM utterance.generation_runs ORDER BY id DESC;

SELECT split, difficulty, count(*) AS cases
FROM utterance.generated
GROUP BY split, difficulty ORDER BY split, difficulty;

SELECT i.code, count(*) AS cases
FROM utterance.generated u
LEFT JOIN intent.definitions i ON i.id = u.expected_intent_id
GROUP BY i.code ORDER BY cases DESC;

SELECT text, split, template_family, source, expected_entities
FROM utterance.generated
WHERE expected_entities->>'category' = 'running_shoes'
ORDER BY id LIMIT 30;

SELECT g.code, t.term, t.metadata
FROM semantic.terms t JOIN semantic.groups g ON g.id = t.semantic_group_id
WHERE t.metadata->>'source' = 'action-equivalence-v2'
ORDER BY g.code, t.term;

SELECT code, description, metadata->>'provenance' AS source
FROM intent.definitions
WHERE metadata->>'provenance' = 'expanded-taxonomy-v2'
ORDER BY code;

-- Must return zero rows: a normalized text/context hash may not cross splits.
SELECT content_hash, count(DISTINCT split)
FROM utterance.generated GROUP BY content_hash
HAVING count(DISTINCT split) > 1;

SELECT created_at, dictionary_version,
       metrics->'generated'->'overall' AS synthetic_metrics,
       metrics->'acceptance'->'overall' AS independent_metrics
FROM evaluation.results ORDER BY created_at DESC LIMIT 5;

-- Version 3: independent rule paths and their named proximity anchors.
SELECT i.code AS intent, r.code AS rule, r.required_states,
       c.kind, g.code AS concept, c.score, c.proximity,
       near_group.code AS near_concept
FROM intent.definitions i
JOIN intent.rules r ON r.intent_id = i.id
JOIN intent.rule_conditions c ON c.rule_id = r.id
JOIN semantic.groups g ON g.id = c.semantic_group_id
LEFT JOIN semantic.groups near_group ON near_group.id = c.near_group_id
WHERE i.code IN ('PAYMENT_DUPLICATE_CHARGE', 'RESTOCK_QUERY', 'STOCK_ALERT_CREATE')
ORDER BY i.code, r.id, c.id;

SELECT created_at,
       metrics->'freshBaseline' AS old_engine_on_fresh_queries,
       metrics->'freshAcceptance'->'overall' AS new_engine_on_fresh_queries
FROM evaluation.results WHERE dictionary_version = 3
ORDER BY created_at DESC LIMIT 1;

-- Catalog terms enrich entities; these rows are never joined into intent scoring.
SELECT t.code AS entity_type, l.term AS alias, e.canonical_value
FROM entity.terms e JOIN entity.types t ON t.id = e.entity_type_id
JOIN entity.aliases a ON a.entity_value_id=e.id
JOIN lexicon.terms l ON l.id=a.lexicon_term_id
WHERE e.active AND a.active AND l.active
ORDER BY t.code, l.normalized_term;
