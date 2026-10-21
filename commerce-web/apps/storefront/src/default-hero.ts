import small from './theme-default-480.webp';
import medium from './theme-default-800.webp';
import original from './theme-default.webp';

export const defaultHero = {
  src: medium,
  srcSet: `${small} 480w, ${medium} 800w, ${original} 1254w`,
};
export const groceryHeroSizes = '(max-width: 540px) calc(100vw - 32px), 50vw';
