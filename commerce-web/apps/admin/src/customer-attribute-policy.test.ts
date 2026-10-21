import { expect, it } from 'vitest';
import { createMissingStarterAttributes, supportsCustomerSegments } from './customer-attribute-policy';

it('limits eligibility to segment API scalar types', () => {
  for (const type of ['text', 'textarea', 'select', 'boolean', 'date']) expect(supportsCustomerSegments(type)).toBe(true);
  for (const type of ['integer', 'decimal', 'datetime', 'multiselect', 'single_select', 'measurement']) expect(supportsCustomerSegments(type)).toBe(false);
});

it('recovers from a partial save without duplicating existing starter attributes', async () => {
  const starters = [{attribute_code:'loyalty_tier'}, {attribute_code:'preferred_channel'}];
  const stored: typeof starters = [];
  let failing = true;
  const save = async (item: typeof starters[number]) => {
    if (item.attribute_code === 'preferred_channel' && failing) throw new Error('Unavailable');
    stored.push(item);
  };
  await expect(createMissingStarterAttributes(starters, async () => stored, save)).rejects.toThrow('Unavailable');
  expect(stored).toEqual([starters[0]]);
  failing = false;
  await createMissingStarterAttributes(starters, async () => stored, save);
  expect(stored).toEqual(starters);
});
