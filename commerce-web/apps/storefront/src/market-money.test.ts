import { describe, expect, it } from 'vitest';
import { displayMoney, minorUnits, subtractMoney } from './market-money';
describe('M10 decimal display', () => {
 it('preserves large monetary values and exact cent subtraction', () => {
  expect(subtractMoney('9999999999000000.01','0.02')).toBe('9999999998999999.99');
  expect(displayMoney('9999999998999999.99','EGP')).toBe('EGP 9,999,999,998,999,999.99');
  expect(displayMoney('1234.5','USD')).toBe('$1,234.50');
 });
 it('rejects fractions of a minor unit and invalid amounts', () => {
  expect(minorUnits('0.001')).toBeNull();expect(minorUnits('NaN')).toBeNull();
  expect(subtractMoney('0.30','0.10')).toBe('0.20');
 });
});
