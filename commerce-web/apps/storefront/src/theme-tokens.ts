import { themeContract, validThemeValue, type ThemeConfiguration } from '@commerce/api-client';
import { productGridCss } from './theme-grid';
export function themeDirection(c: ThemeConfiguration): 'ltr' | 'rtl' {
  return c.tokens['layout.direction'] === 'rtl' ? 'rtl' : 'ltr';
}

export function tokenCss(c: ThemeConfiguration, locale = 'en'): string {
  const declarations = Object.entries(themeContract.tokens).map(([key, def]) => {
    const override = locale.split('-')[0] === 'ar' && (key === 'font.body' || key === 'font.heading') ? c.tokens[key.replace('font.', 'font.arabic.')] : undefined;
    const value = override !== 'inherit' && validThemeValue(def, override) ? override : validThemeValue(def, c.tokens[key]) ? c.tokens[key] : def.default;
    const unit = def.kind === 'number' && !key.startsWith('grid.columns.') ? 'px' : '';
    return `--theme-${key.replaceAll('.', '-')}:${value}${unit}`;
  }).join(';');
  const mobile = validThemeValue(themeContract.tokens['breakpoint.mobile'], c.tokens['breakpoint.mobile']) ? c.tokens['breakpoint.mobile'] : 640;
  const desktop = validThemeValue(themeContract.tokens['breakpoint.desktop'], c.tokens['breakpoint.desktop']) ? c.tokens['breakpoint.desktop'] : 1024;
  const primary = validThemeValue(themeContract.tokens['color.primary'], c.tokens['color.primary']) ? String(c.tokens['color.primary']) : '#146c43';
  const rgb = [1, 3, 5].map(start => parseInt(primary.slice(start, start + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  const foreground = luminance > 0.179 ? '#000000' : '#ffffff';
  return `:root{${declarations};--theme-color-on-primary:${foreground}}@media(max-width:${desktop}px){.theme-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:${mobile}px){.theme-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.theme-hero{min-height:360px}}${productGridCss(c)}`;
}
