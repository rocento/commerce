import { describe, expect, it } from 'vitest';
import fixture from '../../../shared/testing/commerce-flow.json';
import { validCommerceResponse } from './commerceValidation';

describe('shared commerce response contracts', () => {
  it.each([
    ['v1/customer/auth/login', 'POST', fixture.auth],
    ['v1/customer/me', 'GET', fixture.customer],
    ['v1/cart', 'POST', fixture.cart],
    ['v1/customer/locations', 'GET', fixture.locations],
    ['v1/fulfillment/availability', 'GET', fixture.availability],
    ['v1/fulfillment/plan-options', 'POST', fixture.options],
    ['v1/customer/checkout/quote', 'POST', fixture.quote],
    ['v1/customer/checkout/place', 'POST', fixture.detail],
  ] as const)('accepts %s', (path, method, payload) => {
    expect(validCommerceResponse(path, method, payload)).toBe(true);
  });
});
