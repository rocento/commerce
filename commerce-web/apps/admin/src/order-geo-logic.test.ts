import { describe, expect, it } from 'vitest';
import type { Order } from '@commerce/api-client';
import { groupOrderLocations, orderAvatar } from './order-geo-logic';

function order(id: string, latitude: unknown, longitude: unknown): Order {
  return { id, location: { latitude, longitude }, contact: { email: 'sarah.ali@example.test', mobile_number: null } } as Order;
}

describe('order geography', () => {
  it('groups overlapping deliveries without losing orders', () => {
    const points = groupOrderLocations([order('a', 30, 31), order('b', 30, 31), order('c', 29, 31)]);
    expect(points).toHaveLength(2);
    expect(points[0].orders.map(item => item.id)).toEqual(['a', 'b']);
  });
  it('excludes missing, nonnumeric and out-of-range coordinates but allows zero', () => {
    const points = groupOrderLocations([order('zero', 0, 0), order('null', null, 20), order('missing', undefined, 20), order('string', '30', 31), order('nan', NaN, 31), order('infinity', 30, Infinity), order('latitude', 91, 31), order('longitude', 30, -181)]);
    expect(points.map(point => point.orders[0].id)).toEqual(['zero']);
  });
  it('uses customer initials with a mobile fallback', () => {
    const item = order('a', 30, 31);
    expect(orderAvatar(item)).toBe('SA');
    item.contact.email = null;
    item.contact.mobile_number = '+201234567890';
    expect(orderAvatar(item)).toBe('90');
  });
});
