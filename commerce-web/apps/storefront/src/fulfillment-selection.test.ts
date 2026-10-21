import { expect, it } from 'vitest';
import { hasAvailableSelections } from './fulfillment-selection';
const slot = { starts_at: '2026-09-30T10:00:00Z', ends_at: '2026-09-30T11:00:00Z' };
const groups = [{ source_id: 'one', slots: [slot] }, { source_id: 'two', slots: [slot] }];
it('waits for a valid window for every shipment', () => {
  expect(hasAvailableSelections(groups, { one: slot })).toBe(false);
  expect(hasAvailableSelections(groups, { one: slot, two: slot })).toBe(true);
});
it('rejects stale windows after availability changes', () => {
  expect(hasAvailableSelections([{ source_id: 'one', slots: [] }], { one: slot })).toBe(false);
  expect(hasAvailableSelections(groups, { one: slot, two: { ...slot, ends_at: '2026-09-30T12:00:00Z' } })).toBe(false);
});
it('does not reserve an empty result or accept a selection for another source', () => {
  expect(hasAvailableSelections([], {})).toBe(false);
  expect(hasAvailableSelections(groups, { one: slot, other: slot })).toBe(false);
});
