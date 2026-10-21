import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
import {normalize} from './normalize.ts';

export const savedCollectionQuestion = 'Which saved information would you like to see: your wishlist or your saved addresses?';

function requestText(message: string): string | undefined {
  if (message.length > 1000 || languagePattern('saved-collection-language.requestText.pattern.1').test(message)
    || languagePattern('saved-collection-language.requestText.pattern.2').test(message)) return;
  return normalize(message)
    .replace(languagePattern('saved-collection-language.requestText.pattern.3'), '')
    .replace(languagePattern('saved-collection-language.requestText.pattern.4'), '')
    .replace(languagePattern('saved-collection-language.requestText.pattern.5'), '');
}

const saved = ()=>recognitionMemo('saved-collection-language.saved',()=>(languageValue<string>('saved-collection-language.saved.value.1')));
const recall = ()=>recognitionMemo('saved-collection-language.recall',()=>(languageValue<string>('saved-collection-language.recall.value.1')));
const patterns = ()=>recognitionMemo('saved-collection-language.patterns',()=>([
  saved(),
  languageTemplate('saved-collection-language.patterns.template.1', [saved()]),
  languageTemplate('saved-collection-language.patterns.template.2', [saved()]),
  languageTemplate('saved-collection-language.patterns.template.3', [saved()]),
  languageTemplate('saved-collection-language.patterns.template.4', [saved()]),
  languageTemplate('saved-collection-language.patterns.template.5', [saved()]),
  languageTemplate('saved-collection-language.patterns.template.6', [saved()]),
  languageTemplate('saved-collection-language.patterns.template.7', [saved()]),
  languageTemplate('saved-collection-language.patterns.template.8', [saved()]),
  languageValue<string>('saved-collection-language.patterns.value.1'),
  languageTemplate('saved-collection-language.patterns.template.9', [recall()]),
  languageTemplate('saved-collection-language.patterns.template.10', [recall()]),
  languageTemplate('saved-collection-language.patterns.template.11', [recall()]),
  languageValue<string>('saved-collection-language.patterns.value.2'),
]));
const questions = ()=>recognitionMemo('saved-collection-language.questions',()=>(patterns().map(pattern => new RegExp(`^(?:${pattern})$`))));

/** Generic saved-data reads need a domain choice before any customer data read. */
export function savedCollectionRequested(message: string): boolean {
  const text = requestText(message);
  return text !== undefined && questions().some(pattern => pattern.test(text));
}

/** Only whole, explicit choices can fill this question; never accept a write. */
export function savedCollectionChoice(message: string): {intent: 'VIEW_WISHLIST'|'ACCOUNT_ADDRESS_LIST'; text: string} | undefined {
  const text = requestText(message)?.replace(languagePattern('saved-collection-language.text.pattern.1'), '').replace(languagePattern('saved-collection-language.text.pattern.2'), '');
  if (!text) return;
  if (languagePattern('saved-collection-language.savedCollectionChoice.pattern.1').test(text)) {
    return languageValue<{ intent: "VIEW_WISHLIST"; text: string; }>('saved-collection-language.savedCollectionChoice.value.1');
  }
  if (languagePattern('saved-collection-language.savedCollectionChoice.pattern.2').test(text)) {
    return languageValue<{ intent: "ACCOUNT_ADDRESS_LIST"; text: string; }>('saved-collection-language.savedCollectionChoice.value.2');
  }
}
