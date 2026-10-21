import { describe, expect, it } from "vitest";
import type { Location, LocationInput } from "@commerce/api-client";
import {
  deliveryLabel,
  deliveryPinForHeader,
  selectDeliveryLocation,
  shouldRefreshForDelivery,
} from "./locations-logic";

function location(
  id: string,
  formatted_address: string,
  is_default = false,
): Location {
  return {
    id,
    label: "home",
    custom_label: "",
    latitude: 30,
    longitude: 31,
    formatted_address,
    building: "",
    floor: "",
    apartment: "",
    delivery_instructions: "",
    is_default,
    created_at: "",
    updated_at: "",
  } as Location;
}

function guest(formatted_address: string): LocationInput {
  return {
    label: "home",
    custom_label: "",
    latitude: 29.9,
    longitude: 30.8,
    formatted_address,
    building: "",
    floor: "",
    apartment: "",
    delivery_instructions: "",
    is_default: false,
  };
}

describe("delivery location regression behavior", () => {
  it("selects the active saved location before the default", () => {
    const locations = [
      location("home", "Home address", true),
      location("office", "Office address"),
    ];

    expect(selectDeliveryLocation(locations, "office")?.id).toBe("office");
  });

  it("falls back to the default saved location, then the first location", () => {
    const locations = [
      location("first", "First address"),
      location("default", "Default address", true),
    ];

    expect(selectDeliveryLocation(locations, "missing")?.id).toBe("default");
    expect(
      selectDeliveryLocation([location("first", "First address")], "")?.id,
    ).toBe("first");
  });

  it("uses the expected header label for signed-in and guest shoppers", () => {
    expect(
      deliveryLabel({
        customer: { id: "customer" },
        selected: location("home", "Saved address"),
        guest: guest("Guest address"),
      }),
    ).toBe("Saved address");
    expect(
      deliveryLabel({
        customer: { id: "customer" },
        selected: undefined,
        guest: null,
      }),
    ).toBe("Choose a location");
    expect(
      deliveryLabel({
        customer: null,
        selected: undefined,
        guest: guest("Guest address"),
      }),
    ).toBe("Guest address");
    expect(deliveryLabel({ customer: null, selected: undefined, guest: null })).toBe(
      "Choose a location",
    );
  });

  it("uses saved coordinates for customers and guest coordinates otherwise", () => {
    expect(
      deliveryPinForHeader({
        customer: { id: "customer" },
        selected: location("home", "Saved address"),
        guest: guest("Guest address"),
      }),
    ).toEqual({ latitude: 30, longitude: 31 });
    expect(
      deliveryPinForHeader({
        customer: null,
        selected: location("home", "Saved address"),
        guest: guest("Guest address"),
      }),
    ).toEqual({ latitude: 29.9, longitude: 30.8 });
    expect(
      deliveryPinForHeader({ customer: null, selected: undefined, guest: null }),
    ).toBeNull();
  });

  it("refreshes only catalog, product, stock, cart, and delivery-area queries", () => {
    expect(shouldRefreshForDelivery(["catalog-search", "milk"])).toBe(true);
    expect(shouldRefreshForDelivery(["delivery-area", "pin"])).toBe(true);
    expect(shouldRefreshForDelivery(["locations"])).toBe(false);
    expect(shouldRefreshForDelivery([])).toBe(false);
  });
});
