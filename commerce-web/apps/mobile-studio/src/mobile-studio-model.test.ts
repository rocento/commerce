import { describe, it, expect } from "vitest";
import {
  mobileConfigIssues,
  type MobileConfig,
  type MobileMerchant,
} from "@commerce/api-client";
import { readFileSync } from "node:fs";
import {
  initialConfig,
  defaultMobileMerchant,
  GROCERY_MERCHANT_ID,
  canEditMobile,
  appendSection,
  canonical,
  configDiff,
  moveSection,
} from "./mobile-studio-model";
const fixture = JSON.parse(readFileSync(new URL("../../../../commerce-api/rocento-api/crates/domain-mobile/contract/v1/fixtures/merchant-1.json", import.meta.url), "utf8")) as MobileConfig;
const merchant: MobileMerchant = {
  id: fixture.tenantId,
  name: "Market",
  role: "owner",
  entitlements: { wishlist: true, locationPicker: true, reviews: true },
};
const config = () => structuredClone(fixture) as MobileConfig;
describe("Mobile Studio contract parity", () => {
  it("accepts the native fixture and every editable section type", () => {
    expect(
      mobileConfigIssues(config(), merchant.id, merchant.entitlements),
    ).toEqual([]);
    let draft = initialConfig(merchant);
    for (const type of [
      "heroBanner",
      "productGrid",
      "productCarousel",
      "categoryGrid",
      "richText",
      "spacer",
    ] as const)
      draft = appendSection(draft, type);
    expect(
      mobileConfigIssues(draft, merchant.id, merchant.entitlements),
    ).toEqual([]);
  });
  it.each([
    [
      "cross-tenant",
      (c: MobileConfig) => {
        c.tenantId = "00000000-0000-0000-0000-000000000002";
      },
      "MERCHANT_MISMATCH",
    ],
    [
      "contrast",
      (c: MobileConfig) => {
        c.brand.light.onPrimary = c.brand.light.primary;
      },
      "INSUFFICIENT_CONTRAST",
    ],
    [
      "runtime",
      (c: MobileConfig) => {
        c.compatibility.minIosRuntime = "2.0.0";
      },
      "UNSUPPORTED_RUNTIME",
    ],
    [
      "required tab",
      (c: MobileConfig) => {
        c.navigation.tabs = c.navigation.tabs.filter((t) => t !== "cart");
      },
      "REQUIRED_TAB",
    ],
    [
      "duplicate section",
      (c: MobileConfig) => {
        c.screens.home.sections.push(c.screens.home.sections[0]);
      },
      "DUPLICATE_SECTION_ID",
    ],
    [
      "RTL",
      (c: MobileConfig) => {
        c.localization.rtlEnabled = false;
      },
      "RTL_REQUIRED",
    ],
    [
      "translation",
      (c: MobileConfig) => {
        delete c.localization.messages.ar!.hero_label;
      },
      "MISSING_TRANSLATION",
    ],
  ])("rejects %s before saving", (_name, mutate, code) => {
    const c = config();
    mutate(c);
    expect(
      mobileConfigIssues(c, merchant.id, merchant.entitlements).some(
        (i) => i.code === code,
      ),
    ).toBe(true);
  });
  it("rejects executable/unknown payloads and non-entitled features", () => {
    const c = config();
    Object.assign(c.brand, { css: "body{}" });
    expect(
      mobileConfigIssues(c, merchant.id, merchant.entitlements)[0].code,
    ).toContain("SCHEMA_INVALID");
    expect(
      mobileConfigIssues(config(), merchant.id, {}).some(
        (i) => i.code === "NOT_ENTITLED",
      ),
    ).toBe(true);
  });
  it("treats object order as equal while preserving layout order and ignoring configVersion in review", () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    const c = config();
    const moved = moveSection(c, 0, 1);
    expect(c.screens.home.sections[0].id).not.toBe(
      moved.screens.home.sections[0].id,
    );
    expect(configDiff(c, moved)[0].path).toBe("/screens/home/sections");
    expect(configDiff(c, { ...c, configVersion: 100 })).toEqual([]);
  });
  it("uses explicit mobile roles; operators and release admins cannot edit", () => {
    expect(canEditMobile("owner")).toBe(true);
    expect(canEditMobile("designer")).toBe(true);
    expect(canEditMobile("operator")).toBe(false);
    expect(canEditMobile("release_admin")).toBe(false);
  });
});

describe("Admin navigation icons", () => {
  it("accepts registered icons only with compatible native runtimes", () => {
    const config = structuredClone(fixture);
    config.navigation.icons = { home: "location", cart: "wishlist" };
    expect(mobileConfigIssues(config, merchant.id, merchant.entitlements).map(i => i.code)).toContain("ICON_RUNTIME_REQUIRED");
    config.compatibility = { minIosRuntime: "1.1.0", minAndroidRuntime: "1.1.0" };
    expect(mobileConfigIssues(config, merchant.id, merchant.entitlements)).toEqual([]);
    expect(mobileConfigIssues({ ...config, navigation: { ...config.navigation, icons: { home: "arbitrary-svg" } } }, merchant.id, merchant.entitlements).length).toBeGreaterThan(0);
    expect(mobileConfigIssues({ ...config, navigation: { ...config.navigation, icons: { unknown: "home" } } }, merchant.id, merchant.entitlements).length).toBeGreaterThan(0);
  });
});

 describe("Default merchant", () => {
  const grocery = { ...merchant, id: GROCERY_MERCHANT_ID, name: "Grocery" };
  it("prefers Grocery regardless of list order", () => {
    expect(defaultMobileMerchant([merchant, grocery])).toBe(grocery);
  });
  it("honors an explicit selection", () => {
    expect(defaultMobileMerchant([merchant, grocery], merchant.id)).toBe(merchant);
  });
  it("falls back within authorized memberships", () => {
    expect(defaultMobileMerchant([merchant])).toBe(merchant);
    expect(defaultMobileMerchant([], GROCERY_MERCHANT_ID)).toBeUndefined();
  });
});


describe("Deals runtime compatibility", () => {
  it("gates the new tab and icon on runtime 1.2", () => {
    for (const iconsOnly of [false, true]) {
      const draft = config();
      if (iconsOnly) draft.navigation.icons = { home: "deals" };
      else draft.navigation.tabs = ["home", "categories", "deals", "account", "cart"];
      draft.compatibility = { minIosRuntime: "1.1.0", minAndroidRuntime: "1.1.0" };
      expect(mobileConfigIssues(draft, merchant.id, merchant.entitlements).map(i => i.code)).toContain("DEALS_RUNTIME_REQUIRED");
      draft.compatibility = { minIosRuntime: "1.2.0", minAndroidRuntime: "1.2.0" };
      expect(mobileConfigIssues(draft, merchant.id, merchant.entitlements)).toEqual([]);
    }
  });
});
