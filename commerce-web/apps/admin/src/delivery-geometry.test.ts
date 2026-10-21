import { describe, expect, it } from 'vitest';
import type { DeliveryArea } from '@commerce/api-client';
import { deliveryGeometry } from './delivery-geometry';
const area: DeliveryArea = { id: 'area', name: 'Area', center_lat: 30, center_lng: 31, radius_km: 2.5, priority: 1, is_active: true, stocks: [] };
describe('delivery overview geometry', () => {
  it('uses polygon coverage in preference to an old circle', () => {
    expect(deliveryGeometry({ ...area, boundary: [{latitude:30,longitude:31},{latitude:31,longitude:31},{latitude:30,longitude:32}] })).toEqual({kind:'polygon',points:[[30,31],[31,31],[30,32]]});
  });
  it('converts legacy kilometer radii to map meters', () => {
    expect(deliveryGeometry(area)).toEqual({kind:'circle',center:[30,31],radius:2500});
  });
  it('does not silently replace invalid polygons with stale circular coverage', () => {
    expect(deliveryGeometry({...area,boundary:[{latitude:30,longitude:31}]})).toBeNull();
    expect(deliveryGeometry({...area,boundary:Array(3).fill({latitude:91,longitude:31})})).toBeNull();
  });
  it('rejects missing, nonfinite, or nonpositive legacy bounds', () => {
    for(const patch of [{center_lat:NaN},{center_lng:181},{radius_km:0},{radius_km:-2},{radius_km:Infinity}]) expect(deliveryGeometry({...area,...patch})).toBeNull();
  });
});
