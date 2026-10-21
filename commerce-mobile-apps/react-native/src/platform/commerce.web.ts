import { CommerceClient, CommerceError, merchant, type StorefrontConfiguration } from '../core/commerce';

// Browsers cannot access the native refresh-cookie header. Keep public browsing
// available, but do not pretend this native session contract works on the web.
export const commerce = new CommerceClient((url, init) => {
  if (url.includes('/customer/') || url.includes('/cart') || url.includes('/fulfillment/')) {
    return Promise.reject(new CommerceError(400, 'Open the iOS or Android app to sign in and shop.'));
  }
  return fetch(url, init);
}, { get: async () => null, set: async () => {} }, () => crypto.randomUUID());

export const liveConfiguration: StorefrontConfiguration = { identity: merchant, commerce };
