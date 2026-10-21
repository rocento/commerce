import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { validateTheme } from './themes';

it('accepts the resolved pharmacy preset through the storefront theme contract', () => {
  const source = readFileSync(new URL('../../../../commerce-demo/pharmacy/theme.json', import.meta.url), 'utf8');
  const resolved = JSON.parse(source, (_key, value) => {
    if (typeof value !== 'string') return value;
    if (value.startsWith('asset:') || value.startsWith('category:')) return '00000000-0000-4000-8000-000000000001';
    if (value.startsWith('category-link:')) return '/categories/00000000-0000-4000-8000-000000000001';
    return value;
  });
  expect(validateTheme(resolved)).toEqual([]);
});
