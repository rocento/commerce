import type { Order } from '@commerce/api-client';

export type OrderGeoPoint = { key: string; latitude: number; longitude: number; orders: Order[] };

export function groupOrderLocations(orders: Order[]): OrderGeoPoint[] {
  const points = new Map<string, OrderGeoPoint>();
  for (const order of orders) {
    const latitude = order.location?.latitude, longitude = order.location?.longitude;
    if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    const key = `${latitude},${longitude}`;
    const point = points.get(key) ?? { key, latitude, longitude, orders: [] };
    point.orders.push(order);
    points.set(key, point);
  }
  return [...points.values()];
}

export function orderCustomerLabel(order: Order): string {
  return order.contact.email || order.contact.mobile_number || `Customer ${order.customer_id.slice(0, 8)}`;
}

export function orderAvatar(order: Order): string {
  const email = order.contact.email?.split('@')[0];
  if (!email) return order.contact.mobile_number?.slice(-2) || 'C';
  return email.split(/[._\s-]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}
