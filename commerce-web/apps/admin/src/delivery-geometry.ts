import type { DeliveryArea } from '@commerce/api-client';
export type DeliveryGeometry = { kind: 'polygon'; points: [number, number][] } | { kind: 'circle'; center: [number, number]; radius: number };
const validCoordinate = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
export function deliveryGeometry(area: DeliveryArea): DeliveryGeometry | null {
  if (area.boundary?.length) {
    if (area.boundary.length < 3 || !area.boundary.every(p => validCoordinate(p.latitude, p.longitude))) return null;
    return { kind: 'polygon', points: area.boundary.map(p => [p.latitude, p.longitude]) };
  }
  return validCoordinate(area.center_lat, area.center_lng) && Number.isFinite(area.radius_km) && area.radius_km > 0
    ? { kind: 'circle', center: [area.center_lat, area.center_lng], radius: area.radius_km * 1000 }
    : null;
}
const colors = ['#317b6a', '#527bb5', '#9a6aba', '#b47b34', '#b95e6e', '#398eaa'];
export function deliveryAreaColor(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}
