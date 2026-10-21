import {readFileSync, writeFileSync} from 'node:fs';
import {normalize as engineNormalize} from '../../app/commerce_language_engine/src/normalize.ts';

// Read-only customer requests. Each pattern is authored, then expanded over
// natural collection names with singular/plural agreement where needed.
const collections = [
  {name: 'wishlist', be: 'is'},
  {name: 'wish list', be: 'is'},
  {name: 'wish-list', be: 'is'},
  {name: 'wishlists', be: 'are'},
  {name: 'wish lists', be: 'are'},
  {name: 'favorites', be: 'are'},
  {name: 'favourites', be: 'are'},
  {name: 'saved items', be: 'are'},
  {name: 'saved products', be: 'are'},
  {name: 'saved-for-later list', be: 'is'},
];

const families = {
  location: [
    'where {be} my {c}?',
    'where can I find my {c}?',
    'where do I find my {c}?',
    'where do I go to see my {c}?',
    'where can I see my {c}?',
    'where can I view my {c}?',
    'where do I look for my {c}?',
    'where do I access my {c}?',
    'where can I access my {c}?',
    'where {be} my {c} located?',
    'where did my {c} go?',
    'where {be} my {c} on here?',
  ],
  access: [
    'how do I find my {c}?',
    'how can I find my {c}?',
    'how do I access my {c}?',
    'how can I access my {c}?',
    'how do I open my {c}?',
    'how can I open my {c}?',
    'how do I get to my {c}?',
    'how can I get to my {c}?',
    'how do I see my {c}?',
    'how can I see my {c}?',
    'how do I view my {c}?',
    'how can I view my {c}?',
  ],
  direct_read: [
    'show me my {c}',
    'let me see my {c}',
    'let me view my {c}',
    'bring up my {c}',
    'pull up my {c}',
    'display my {c}',
    'display my {c} for me',
    'take me to my {c}',
    'find my {c} for me',
    'locate my {c}',
    'list out my {c}',
    'show a list of my {c}',
    'show me the contents of my {c}',
    'open up my {c}',
    'open my {c} for me',
    'show my {c} to me',
  ],
  polite_read: [
    'could you show me my {c}?',
    'can you show me my {c}?',
    'would you show me my {c}?',
    'can you let me see my {c}?',
    'could you let me view my {c}?',
    'could you bring up my {c}?',
    'can you pull up my {c}?',
    'would you open my {c} for me?',
    'could you display my {c}?',
    'can you take me to my {c}?',
    'could you find my {c} for me?',
    'can you locate my {c}?',
    'please bring up my {c}',
    'please pull up my {c}',
    'please let me see my {c}',
    'show me my {c}, please',
  ],
  contents: [
    'what is in my {c}?',
    'what is on my {c}?',
    "what's in my {c}?",
    "what's on my {c}?",
    'what items are in my {c}?',
    'what products are in my {c}?',
    'what items are on my {c}?',
    'what products are on my {c}?',
    'show what I have in my {c}',
    'show me what is in my {c}',
    'list the contents of my {c}',
    'let me see what is in my {c}',
  ],
  desire: [
    'I want to see my {c}',
    'I want to view my {c}',
    'I want to open my {c}',
    'I need to see my {c}',
    'I need to view my {c}',
    'I need to access my {c}',
    'I would like to see my {c}',
    'I would like to view my {c}',
    "I'd like to open my {c}",
    "I'd like to see my {c}",
    'I want to look at my {c}',
    'I need to look at my {c}',
  ],
  return: [
    'show me my {c} again',
    'open my {c} again',
    'bring up my {c} again',
    'pull up my {c} again',
    'take me back to my {c}',
    'let me see my {c} again',
    'can I see my {c} again?',
    'could you reopen my {c}?',
    'reopen my {c}',
    'go back to my {c}',
    'return to my {c}',
    'show my {c} once more',
  ],
  cannot_find: [
    "I can't find my {c}",
    'I cannot find my {c}',
    "I can't see my {c}",
    'I cannot see my {c}',
    "I can't locate my {c}",
    "I can't find my {c}, please show me",
    'help me find my {c}',
    'help me locate my {c}',
    'help me get to my {c}',
    'help me open my {c}',
    "I'm looking for my {c}",
    'I am looking for my {c}',
  ],
  short_request: [
    'my {c}',
    'my {c}, please',
    'my {c} please',
    'my {c}?',
    'view my {c} now',
    'open my {c} now',
    'show my {c} now',
    'let me look at my {c}',
    'show me the list of my {c}',
    'show my {c} here',
    'open my {c} here',
    'can I see my {c}?',
  ],
};

// Explicit items/products or a for-later collection make these wishlist reads.
// Generic "what did I save?" requires a choice of saved information types.
const savedRecall = [
  'what have I saved for later?',
  'what did I save for later?',
  'which items did I save?',
  'which products did I save?',
  'which items have I saved?',
  'which products have I saved?',
  'what items did I save for later?',
  'what products did I save for later?',
  'which items have I saved for later?',
  'which products have I saved for later?',
  'show me what I saved for later',
  'show what I saved for later',
  'list what I saved for later',
  'list the items I saved',
  'list the products I saved',
  'show me the items I saved',
  'show me the products I saved',
  'show the items I saved for later',
  'show the products I saved for later',
  'let me see what I saved for later',
  'let me view the items I saved',
  'let me view the products I saved',
  'could you show me what I saved for later?',
  'can I see the items I saved for later?',
  'please show the items I have saved',
  'please show the products I have saved',
  'I want to view what I saved for later',
  "I'd like to see the items I saved",
  'bring up the items I saved',
  'pull up the products I saved',
  'show my bookmarked items',
  'show my bookmarked products',
  'show me my bookmarked items',
  'where are the items I saved?',
  'where do I find the products I saved?',
];

// Newness is checked against all old cases, not only the old read family.
// Ignore spelling case, whitespace, punctuation, and possessive apostrophes.
export function normalizePhrase(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
const old = JSON.parse(readFileSync(new URL('../wishlist/cases.json', import.meta.url), 'utf8'));
const oldPhrases = new Set(old.cases.map(row => normalizePhrase(row.text)));
const oldEnginePhrases = new Set(old.cases.map(row => engineNormalize(row.text)));
const seen = new Set(oldPhrases);
const seenEngine = new Set(oldEnginePhrases);
const patterns = Object.entries(families).flatMap(([family, items]) => items.map((text, index) => ({family, text, pattern: `${family}-${index + 1}`})));
const candidates = [];
function candidate(family, text, pattern, collection) {
  const normalized = normalizePhrase(text);
  const engineNormalized = engineNormalize(text);
  if (seen.has(normalized) || seenEngine.has(engineNormalized)) return;
  seen.add(normalized);
  seenEngine.add(engineNormalized);
  candidates.push({family, text, pattern, ...(collection ? {collection} : {})});
}

// Alternate space/hyphen spelling for the same normalized collection name.
// Round-robin patterns keeps each family and alias represented evenly.
// All saved-recall forms are included.
savedRecall.forEach((text, i) => candidate('saved_recall', text, `saved_recall-${i + 1}`));
for (const [index, pattern] of patterns.entries()) {
  for (const collection of collections) {
    if (collection.name === 'wish list' && index % 2 === 1) continue;
    if (collection.name === 'wish-list' && index % 2 === 0) continue;
    candidate(pattern.family, pattern.text.replaceAll('{c}', collection.name).replaceAll('{be}', collection.be), pattern.pattern, collection.name);
  }
}
const recall = candidates.filter(row => row.family === 'saved_recall');
const expanded = candidates.filter(row => row.family !== 'saved_recall');
const needed = 1000 - recall.length;
if (expanded.length < needed) throw new Error('Not enough new phrases after both normalization checks.');
// Deterministic even sampling includes the first and last authored structures.
const selected = [...recall, ...Array.from({length: needed}, (_, i) => expanded[Math.floor(i * (expanded.length - 1) / (needed - 1))])];
// Keep the user's concrete question at the top of the downloadable corpus.
selected.sort((a, b) => Number(b.text === 'where is my wishlist?') - Number(a.text === 'where is my wishlist?'));
const cases = selected.map((row, i) => ({
  id: `WLR-${String(i + 1).padStart(4, '0')}`,
  ...row,
  expected: {behavior: 'intent', intent: 'VIEW_WISHLIST'},
  context: {},
  split: Number(row.pattern.split('-').at(-1)) % 5 === 0 ? 'variation' : 'development',
}));
if (cases.length !== 1000 || new Set(cases.map(row => normalizePhrase(row.text))).size !== 1000
  || new Set(cases.map(row => engineNormalize(row.text))).size !== 1000) {
  throw new Error('Expected exactly 1000 normalized-unique phrases.');
}
if (cases.some(row => oldPhrases.has(normalizePhrase(row.text)) || oldEnginePhrases.has(engineNormalize(row.text)))) {
  throw new Error('New read corpus overlaps the existing wishlist corpus.');
}
if (collections.some(collection => !cases.some(row => row.collection === collection.name))) {
  throw new Error('Every collection alias must be represented.');
}
const description = '1000 new English customer requests to locate, open, or read their own wishlist. Authored structural patterns expanded over collection aliases and explicit saved-item/product or for-later recall questions. Generic saved-information questions require clarification and are excluded. Normalized duplicates with the existing wishlist corpus are excluded. Synthetic regression coverage; no independent holdout accuracy is claimed.';
writeFileSync(new URL('./cases.json', import.meta.url), JSON.stringify({version: 1, language: 'English', description, cases}, null, 2) + '\n');
console.log(`Generated ${cases.length} new normalized-unique wishlist read phrases across ${new Set(cases.map(row => row.family)).size} families.`);
