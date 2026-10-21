import {languageValue,languagePattern,languageTemplate,recognitionMemo} from './recognition-rules.ts';
// Comparison vocabulary comes from the active dictionary; bootstrap data is a JSON seed.
export const comparisonVersion = 1;
export type ComparisonOperator = '<' | '<=' | '>' | '>=' | '=';
export const comparisonOperators = ():Readonly<Record<string, ComparisonOperator>>=>recognitionMemo('comparison-operators.comparisonOperators',()=>(Object.freeze(
languageValue<Readonly<Record<string, ComparisonOperator>>>('comparison-operators.comparisonOperators.value.1'))));
export const comparisonPhrasePattern = ()=>recognitionMemo('comparison-operators.comparisonPhrasePattern',()=>(Object.keys(comparisonOperators())
  .sort((a, b) => b.length - a.length || a.localeCompare(b))
  .map(phrase => phrase.replaceAll(' ', languageValue<string>('comparison-operators.comparisonPhrasePattern.value.1'))).join('|')));
export function comparisonOperator(phrase: string): ComparisonOperator | undefined {
  const key = phrase.toLowerCase().trim().replace(languagePattern('comparison-operators.key.pattern.1'), ' ');
  return Object.hasOwn(comparisonOperators(), key) ? comparisonOperators()[key] : undefined;
}
export function comparisonDirection(phrase: string): 'min' | 'max' | 'exact' | undefined {
  const operator = comparisonOperator(phrase);
  if (operator === '<' || operator === '<=') return 'max';
  if (operator === '>' || operator === '>=') return 'min';
  return operator === '=' ? 'exact' : undefined;
}
