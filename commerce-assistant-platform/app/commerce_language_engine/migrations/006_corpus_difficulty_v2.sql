BEGIN;
ALTER TABLE generated_utterances DROP CONSTRAINT IF EXISTS generated_utterances_difficulty_check;
ALTER TABLE generated_utterances DROP CONSTRAINT IF EXISTS generated_utterances_difficulty_v2_check;
ALTER TABLE generated_utterances ADD CONSTRAINT generated_utterances_difficulty_v2_check CHECK (
 difficulty IN (
  'EASY','MEDIUM','HARD','AMBIGUOUS','CONTEXT_REQUIRED','NEGATIVE_CONFLICT',
  'TYPO_NOISE','PARAPHRASE','REFERENCE','NEGATION','HARD_NEGATIVE','INCOMPLETE','COMPOUND'
 )
);
COMMIT;
