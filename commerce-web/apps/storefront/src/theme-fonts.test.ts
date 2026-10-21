import { describe, expect, it } from 'vitest';
import { defaultTheme, validateTheme } from '@commerce/api-client';
import { tokenCss } from './theme-tokens';

describe('theme font selection', () => {
  it('preserves existing fonts for legacy themes and inherited Arabic', () => {
    const theme = defaultTheme();
    theme.tokens['font.body'] = 'Jost';
    expect(validateTheme(theme)).toEqual([]);
    expect(tokenCss(theme, 'ar')).toContain('--theme-font-body:Jost;');
    theme.tokens['font.arabic.body'] = 'inherit';
    expect(tokenCss(theme, 'ar')).toContain('--theme-font-body:Jost;');
  });
  it('applies each Arabic font only in Arabic, including regional locales', () => {
    for (const font of ['Cairo', 'Tajawal', 'Noto Sans Arabic']) {
      const theme = defaultTheme();
      theme.tokens['font.body'] = 'Jost';
      theme.tokens['font.heading'] = 'Georgia';
      theme.tokens['font.arabic.body'] = font;
      theme.tokens['font.arabic.heading'] = font;
      expect(validateTheme(theme)).toEqual([]);
      expect(tokenCss(theme, 'ar-EG')).toContain(`--theme-font-body:${font};`);
      expect(tokenCss(theme, 'ar')).toContain(`--theme-font-heading:${font};`);
      expect(tokenCss(theme, 'en')).toContain('--theme-font-body:Jost;');
      expect(tokenCss(theme, 'en')).toContain('--theme-font-heading:Georgia;');
    }
  });
  it('rejects invalid fonts and prevents CSS injection', () => {
    const theme = defaultTheme();
    theme.tokens['font.arabic.body'] = 'Cairo;display:none';
    expect(validateTheme(theme)).toContain('Tokens: font.arabic.body');
    expect(tokenCss(theme, 'ar')).not.toContain('display:none');
  });
});
