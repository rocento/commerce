import {languageValue,languagePattern,languageTemplate} from './recognition-rules.ts';
/** Whole-request English commands for the browser's comparison selection.
 * Keep named products, negation, conditions and later actions outside this rule.
 */
export function clearComparisonRequested(message: string): boolean {
  if (languagePattern('comparison-language.clearComparisonRequested.pattern.1').test(message) || message.length > 4000) return false;
  let text = message.normalize('NFKC').toLowerCase().trim().replace(languagePattern('comparison-language.text.pattern.1'), '').trim().replace(languagePattern('comparison-language.text.pattern.2'), ' ');
  text = text.replace(languagePattern('comparison-language.clearComparisonRequested.pattern.2'), '');
  text = text.replace(languagePattern('comparison-language.clearComparisonRequested.pattern.3'), '');
  // These reviewed noun typos are accepted only within a complete list command.
  const compare = languageValue<string>('comparison-language.compare.value.1');
  const list = languageTemplate('comparison-language.list.template.1', [compare]);
  const all = languageValue<string>('comparison-language.all.value.1');
  const patterns = [
    languageTemplate('comparison-language.patterns.template.1', [list]),
    languageTemplate('comparison-language.patterns.template.2', [all, list]),
    languageTemplate('comparison-language.patterns.template.3', [list]),
    languageValue<string>('comparison-language.patterns.value.1'),
    languageTemplate('comparison-language.patterns.template.4', [all]),
    languageTemplate('comparison-language.patterns.template.5', [list]),
    languageValue<string>('comparison-language.patterns.value.2'),
    languageValue<string>('comparison-language.patterns.value.3'),
  ];
  return patterns.some(pattern => new RegExp(`^(?:${pattern})$`).test(text));
}
