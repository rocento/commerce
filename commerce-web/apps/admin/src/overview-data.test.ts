import { expect, it } from 'vitest';
import { salesSeries } from './overview-data';

const row = { day: '2026-09-20', currency: 'USD', orders: 2, cancelled: 1, gross: '30.00', refunds: '5.00', net: '25.00' };

it('keeps currencies separate and fills missing UTC days with zero', () => {
  const series = salesSeries([row, { ...row, currency: 'EGP', net: '1000.00', orders: 10 }], 'USD', '2026-09-19', '2026-09-21');
  expect(series).toEqual([
    { day: '2026-09-19', orders: 0, net: 0, refunds: 0 },
    { day: '2026-09-20', orders: 2, net: 25, refunds: 5 },
    { day: '2026-09-21', orders: 0, net: 0, refunds: 0 },
  ]);
});

it('preserves negative net values from refunds and excludes dates outside the range', () => {
  const series = salesSeries([{ ...row, net: '-10.00', refunds: '40.00' }, { ...row, day: '2026-09-18' }], 'USD', '2026-09-20', '2026-09-20');
  expect(series).toEqual([{ day: '2026-09-20', orders: 2, net: -10, refunds: 40 }]);
});

it('aggregates all matching daily rows instead of discarding duplicate buckets', () => {
  const series = salesSeries([row, row], 'USD', '2026-09-20', '2026-09-20');
  expect(series[0]).toEqual({ day: '2026-09-20', orders: 4, net: 50, refunds: 10 });
});
