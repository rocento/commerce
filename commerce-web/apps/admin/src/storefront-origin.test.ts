import { describe, expect, it } from 'vitest';
import { storefrontOrigin } from './storefront-origin';
describe('merchant storefront pairing', () => {
  it('pairs each merchant admin with its own storefront', () => {
    expect(storefrontOrigin('', { protocol: 'https:', hostname: 'test-admin.rocento.com' })).toBe('https://test.rocento.com');
    expect(storefrontOrigin('', { protocol: 'https:', hostname: 'second-client-admin.rocento.com' })).toBe('https://second-client.rocento.com');
  });
  it('preserves explicit deployment URLs and local previews', () => {
    expect(storefrontOrigin('https://grocery.rocento.com', { protocol: 'https:', hostname: 'admin.rocento.com' })).toBe('https://grocery.rocento.com');
    expect(storefrontOrigin('', { protocol: 'http:', hostname: 'localhost' })).toBe('http://localhost:5173');
  });
});
