import { describe, expect, it } from 'vitest';
import { storefrontColors } from './designColors';

describe('merchant theme reflection', () => {
  it('preserves all configured colors and derives supporting colors without a grocery tint', () => {
    const palette = { primary: '#0000FF', onPrimary: '#FFFF00', background: '#FFFFFF', surface: '#EEEEFF', text: '#000000' };
    expect(storefrontColors(palette)).toEqual({ ...palette, muted: '#4d4d4d', border: '#d9d9d9', tint: '#ebebff', hero: '#EEEEFF' });
    const updated = { ...palette, primary: '#FF0000', background: '#000000', text: '#FFFFFF' };
    expect(storefrontColors(updated)).toEqual({ ...updated, muted: '#b3b3b3', border: '#262626', tint: '#140000', hero: '#EEEEFF' });
  });
  it('supports standalone startup without Studio configuration', () => {
    expect(storefrontColors().primary).toBe('#063C22');
  });
});
