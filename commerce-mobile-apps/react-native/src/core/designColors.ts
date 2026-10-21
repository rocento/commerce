import type { DesignColors } from './design';

const bundled: DesignColors = {
  background: '#FFFFFF', surface: '#F1F4F0', primary: '#063C22',
  text: '#17251D', onPrimary: '#FFFFFF',
};
function mix(foreground: string, background: string, amount: number): string {
  return '#' + [1, 3, 5].map(offset => Math.round(
    parseInt(foreground.slice(offset, offset + 2), 16) * amount +
    parseInt(background.slice(offset, offset + 2), 16) * (1 - amount),
  ).toString(16).padStart(2, '0')).join('');
}

// Supporting UI colors must follow the merchant palette as it changes.
export function storefrontColors(palette: DesignColors = bundled) {
  return {
    ...palette,
    muted: mix(palette.text, palette.background, .7),
    border: mix(palette.text, palette.background, .15),
    tint: mix(palette.primary, palette.background, .08),
    hero: palette.surface,
  };
}
