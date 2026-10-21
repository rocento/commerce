import { expect, it } from 'vitest';
import { findSearchMatch } from './search-match';

it('highlights Arabic variants without changing the displayed product name', () => {
  const name = 'عبوة شَـاي أَخْضَر ١٢٣';
  const match = findSearchMatch(name, 'شاي اخضر 123');
  expect(match).not.toBeNull();
  expect(name.slice(match!.start, match!.end)).toBe('شَـاي أَخْضَر ١٢٣');
  expect(findSearchMatch('قهوة على', 'قهوه علي')).toEqual({ start: 0, end: 8 });
});

it('preserves English matching and UTF-16 offsets around emoji and Arabic diacritics', () => {
  expect(findSearchMatch('Green Tea', 'tea')).toEqual({ start: 6, end: 9 });
  const name = '🍵 شَايُ ممتاز';
  const match = findSearchMatch(name, 'شاي');
  expect(name.slice(match!.start, match!.end)).toBe('شَايُ');
  expect(findSearchMatch(name, '')).toBeNull();
  expect(findSearchMatch(name, 'coffee')).toBeNull();
});
