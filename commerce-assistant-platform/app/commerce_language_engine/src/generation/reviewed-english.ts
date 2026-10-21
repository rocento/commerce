/** Evaluation/enrichment fixtures; runtime vocabulary is in database snapshots. */
import seed from '../../seeds/reviewed-english.en.json' with {type:'json'};
export const englishVocabulary=seed.englishVocabulary;
export const heldEnglishTerms=new Set(seed.heldEnglishTerms);
export const englishVocabularySource=seed.englishVocabularySource;
