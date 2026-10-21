import { describe, expect, it } from 'vitest';
import { hasDeliveryAddress } from './delivery-requirement';

describe('delivery address validation', () => {
  it('requires a street address and valid coordinates', () => {
    const address = { latitude: 30, longitude: 31, formatted_address: '15 Road 9' };
    expect(hasDeliveryAddress(address)).toBe(true);
    for (const invalid of [null, { ...address, formatted_address: '  ' }, { ...address, latitude: NaN }, { ...address, longitude: 181 }]) {
      expect(hasDeliveryAddress(invalid)).toBe(false);
    }
  });
});
