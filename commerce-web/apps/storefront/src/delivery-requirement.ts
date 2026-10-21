import type { LocationInput } from '@commerce/api-client';

export function hasDeliveryAddress(address: Pick<LocationInput, 'latitude' | 'longitude' | 'formatted_address'> | null | undefined) {
  return !!address && Number.isFinite(address.latitude) && Math.abs(address.latitude) <= 90
    && Number.isFinite(address.longitude) && Math.abs(address.longitude) <= 180
    && typeof address.formatted_address === "string" && !!address.formatted_address.trim();
}
