import { locationAddress } from "@commerce/api-client";
import type { Location, LocationInput } from "@commerce/api-client";

export const deliveryRefreshQueryKeys = [
  "catalog-search",
  "product",
  "stock",
  "cart",
  "delivery-area",
] as const;

export function shouldRefreshForDelivery(queryKey: readonly unknown[]) {
  return deliveryRefreshQueryKeys.includes(
    String(queryKey[0]) as (typeof deliveryRefreshQueryKeys)[number],
  );
}

export function selectDeliveryLocation(
  locations: Location[] | undefined,
  activeId: string,
) {
  return (
    locations?.find((location) => location.id === activeId) ||
    locations?.find((location) => location.is_default) ||
    locations?.[0]
  );
}

export function deliveryLabel({
  customer,
  selected,
  guest,
  fallback = "Choose a location",
}: {
  customer: unknown;
  selected: Location | undefined;
  guest: LocationInput | null;
  fallback?: string;
}) {
  if (customer) return (selected ? locationAddress(selected) : "") || fallback;
  return (guest ? locationAddress(guest) : "") || fallback;
}

export function deliveryPinForHeader({
  customer,
  selected,
  guest,
}: {
  customer: unknown;
  selected: Pick<Location, "latitude" | "longitude"> | undefined;
  guest: Pick<LocationInput, "latitude" | "longitude"> | null;
}) {
  const pin = customer ? selected : guest;
  const { latitude, longitude } = pin ?? {};
  return latitude === undefined || longitude === undefined
    ? null
    : { latitude, longitude };
}
