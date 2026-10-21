import { expect, it } from 'vitest';
import { categoryImageURL, merchant } from './commerce';

it('resolves category thumbnails through the fixed merchant media API', () => {
  const thumbnail = '11111111-1111-4111-8111-111111111111';
  expect(categoryImageURL({ id: 'fruit', slug: 'fruit', name: 'Fruit', thumbnail }))
    .toBe(`${merchant.origin}/v1/catalog/media/${thumbnail}/content`);
});
it.each([undefined, null, '', 'https://untrusted.example/image.png', '../other'])('omits missing or invalid category media: %s', thumbnail => {
  expect(categoryImageURL({ id: 'fruit', slug: 'fruit', name: 'Fruit', thumbnail })).toBeUndefined();
});
