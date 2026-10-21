import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {normalize} from './normalize.ts';

const collection = ()=>recognitionMemo('wishlist-read-language.collection',()=>(languageValue<string>('wishlist-read-language.collection.value.1')));
const ownedCollection = ()=>recognitionMemo('wishlist-read-language.ownedCollection',()=>(languageTemplate('wishlist-read-language.ownedCollection.template.1', [collection()])));
const personalCollection = ()=>recognitionMemo('wishlist-read-language.personalCollection',()=>(languageTemplate('wishlist-read-language.personalCollection.template.1', [collection()])));
const readVerb = ()=>recognitionMemo('wishlist-read-language.readVerb',()=>(languageValue<string>('wishlist-read-language.readVerb.value.1')));
const savedThings = ()=>recognitionMemo('wishlist-read-language.savedThings',()=>(languageValue<string>('wishlist-read-language.savedThings.value.1')));
const patterns = ()=>recognitionMemo('wishlist-read-language.patterns',()=>([
  `${ownedCollection()}`,
  languageTemplate('wishlist-read-language.patterns.template.1', [personalCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.2', [personalCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.3', [personalCollection()]),
  `${readVerb()} ${ownedCollection()}`,
  languageTemplate('wishlist-read-language.patterns.template.4', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.5', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.6', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.7', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.8', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.9', [personalCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.10', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.11', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.12', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.13', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.14', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.15', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.16', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.17', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.18', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.19', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.20', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.21', [readVerb(), ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.22', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.23', [ownedCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.24', [personalCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.25', [personalCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.26', [personalCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.27', [personalCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.28', [personalCollection(), personalCollection()]),
  languageTemplate('wishlist-read-language.patterns.template.29', [personalCollection(), personalCollection()]),
  `${readVerb()} ${savedThings()}`,
  languageTemplate('wishlist-read-language.patterns.template.30', [savedThings()]),
  languageValue<string>('wishlist-read-language.patterns.value.1'),
  languageValue<string>('wishlist-read-language.patterns.value.2'),
  languageValue<string>('wishlist-read-language.patterns.value.3'),
  languageValue<string>('wishlist-read-language.patterns.value.4'),
  languageValue<string>('wishlist-read-language.patterns.value.5'),
  languageValue<string>('wishlist-read-language.patterns.value.6'),
  languageTemplate('wishlist-read-language.patterns.template.31', [savedThings()]),
]));
const reads = ()=>recognitionMemo('wishlist-read-language.reads',()=>(patterns().map(pattern => new RegExp(`^(?:${pattern})$`))));

/** Recognize complete requests to read the current shopper's saved collection. */
export function wishlistReadRequested(message: string): boolean {
  // Validate raw text before normalization can erase separators or quoted data.
  if (message.length > 1000 || languagePattern('wishlist-read-language.wishlistReadRequested.pattern.1').test(message)
    || languagePattern('wishlist-read-language.wishlistReadRequested.pattern.2').test(message)) return false;
  let text = normalize(message);
  text = text.replace(languagePattern('wishlist-read-language.wishlistReadRequested.pattern.3'), '');
  text = text.replace(languagePattern('wishlist-read-language.wishlistReadRequested.pattern.4'), '');
  text = text.replace(languagePattern('wishlist-read-language.wishlistReadRequested.pattern.5'), '');
  return reads().some(pattern => pattern.test(text));
}
