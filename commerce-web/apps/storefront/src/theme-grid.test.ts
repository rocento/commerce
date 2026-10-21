import { describe, expect, it } from 'vitest';
import { defaultTheme, validateTheme } from '@commerce/api-client';
import { productGridCss } from './theme-grid';

describe('responsive product grid settings', () => {
  it('preserves published layouts without column settings', () => {
    expect(validateTheme(defaultTheme())).toEqual([]);
    expect(productGridCss(defaultTheme())).toBe('');
  });
  it('uses independent counts and the theme breakpoints for all product grids', () => {
    const theme = defaultTheme();
    Object.assign(theme.tokens, { 'grid.columns.desktop': 5, 'grid.columns.tablet': 4, 'grid.columns.mobile': 1, 'breakpoint.desktop': 1100, 'breakpoint.mobile': 600 });
    expect(validateTheme(theme)).toEqual([]);
    const css = productGridCss(theme);
    expect(css).toContain(':is(.theme-grid,.product-grid)');
    expect(css).toContain('repeat(5,minmax(0,1fr))');
    expect(css).toContain('@media(max-width:1100px)');
    expect(css).toContain('repeat(4,minmax(0,1fr))');
    expect(css).toContain('@media(max-width:600px)');
    expect(css).toContain('repeat(1,minmax(0,1fr))');
  });
  it('rejects fractional, out-of-range and injected column counts', () => {
    for (const value of [0, 7, 2.5, '2;display:none']) {
      const theme = defaultTheme();
      theme.tokens['grid.columns.mobile'] = value;
      expect(validateTheme(theme).length).toBeGreaterThan(0);
    }
  });
});
