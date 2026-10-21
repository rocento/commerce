-- New intent definitions and their semantic conditions.
SELECT i.code AS intent, g.code AS semantic_group, c.kind, c.score
FROM intent.definitions i
JOIN intent.rules r ON r.intent_id=i.id
JOIN intent.rule_conditions c ON c.rule_id=r.id
JOIN semantic.groups g ON g.id=c.semantic_group_id
WHERE i.metadata->>'provenance'='industry-coverage-v7'
ORDER BY i.code,c.id;

-- Source-tagged synthetic examples by split and difficulty.
SELECT split,difficulty,count(*)
FROM utterance.generated
WHERE source='industry-coverage-v7'
GROUP BY split,difficulty ORDER BY split,difficulty;

-- Read examples and authored labels, including abstentions.
SELECT u.text,i.code AS expected_intent,u.expected_status,u.expected_entities,u.split
FROM utterance.generated u
LEFT JOIN intent.definitions i ON i.id=u.expected_intent_id
WHERE u.source='industry-coverage-v7'
ORDER BY u.id LIMIT 100;

SELECT phrase FROM lexicon.request_prefixes ORDER BY id;
SELECT f.code,i.code AS intent,f.actions,f.targets,f.prepositions
FROM action.frames f JOIN intent.definitions i ON i.id=f.intent_id ORDER BY f.id;
