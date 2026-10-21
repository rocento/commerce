import { themeContract, validThemeValue, type ThemeConfiguration } from '@commerce/api-client';

export function productGridCss(theme: ThemeConfiguration): string {
  const keys = ['grid.columns.desktop', 'grid.columns.tablet', 'grid.columns.mobile'];
  if (!keys.some(key => Object.hasOwn(theme.tokens, key))) return '';
  const value = (key: string) => validThemeValue(themeContract.tokens[key], theme.tokens[key])
    ? theme.tokens[key] : themeContract.tokens[key].default;
  // Match every presentation with enough specificity to override its grid defaults.
  const selector = '.store-shell[data-presentation] :is(.theme-grid,.product-grid)';
  const rule = (key: string) => `${selector}{grid-template-columns:repeat(${value(key)},minmax(0,1fr))}`;
  return `${rule(keys[0])}@media(max-width:${value('breakpoint.desktop')}px){${rule(keys[1])}}@media(max-width:${value('breakpoint.mobile')}px){${rule(keys[2])}}`;
}
