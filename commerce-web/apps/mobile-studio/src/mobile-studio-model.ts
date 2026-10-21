import type {
  MobileConfig,
  MobileMerchant,
  MobileSection,
} from "@commerce/api-client";
// Stable tenant identity; only select it from the caller's authorized memberships.
export const GROCERY_MERCHANT_ID = "312f9ac8-4888-4d35-92a0-e5fdb3bf59b8";
export function defaultMobileMerchant(merchants: MobileMerchant[], selected = "") {
  return merchants.find(m => m.id === selected)
    ?? merchants.find(m => m.id === GROCERY_MERCHANT_ID)
    ?? merchants[0];
}
export const cornerPresets = [
  { token: "none", label: "Square", radius: 0 },
  { token: "small", label: "Soft", radius: 8 },
  { token: "medium", label: "Rounded", radius: 18 },
  { token: "large", label: "Extra rounded", radius: 28 },
] as const;
export const EMPTY_ASSET = "00000000-0000-0000-0000-000000000000";
export const sectionTypes: MobileSection["type"][] = [
  "heroBanner",
  "productGrid",
  "productCarousel",
  "categoryGrid",
  "richText",
  "spacer",
];
export const sectionNames: Record<MobileSection["type"], string> = {
  heroBanner: "Hero banner",
  productGrid: "Product grid",
  productCarousel: "Product carousel",
  categoryGrid: "Categories",
  richText: "Text",
  spacer: "Space",
};
export function canEditMobile(role: MobileMerchant["role"]) {
  return role === "owner" || role === "designer";
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function asDraft(config: MobileConfig): MobileConfig {
  return { ...structuredClone(config), configVersion: 0 };
}
export function initialConfig(
  merchant: MobileMerchant,
  logo = EMPTY_ASSET,
): MobileConfig {
  return {
    schemaVersion: "1.0.0",
    configVersion: 0,
    tenantId: merchant.id,
    brand: {
      displayName: merchant.name.slice(0, 80),
      logoAssetId: logo,
      fontToken: "system",
      radiusToken: "medium",
      density: "comfortable",
      light: {
        primary: "#B45134",
        onPrimary: "#FFFFFF",
        background: "#FAF8F7",
        surface: "#FFFFFF",
        text: "#242424",
      },
      dark: {
        primary: "#DA7756",
        onPrimary: "#242424",
        background: "#181615",
        surface: "#282320",
        text: "#FAF8F7",
      },
    },
    navigation: { tabs: ["home", "categories", "cart", "account"] },
    screens: {
      home: {
        sections: [
          { id: "welcome", type: "richText", props: { textKey: "welcome" } },
        ],
      },
    },
    features: { wishlist: false, locationPicker: false, reviews: false },
    localization: {
      defaultLocale: "en",
      supportedLocales: ["en", "ar"],
      rtlEnabled: true,
      messages: {
        en: { welcome: "Welcome to your store" },
        ar: { welcome: "مرحباً بكم في متجرنا" },
      },
    },
    compatibility: { minIosRuntime: "1.0.0", minAndroidRuntime: "1.0.0" },
  };
}
export function appendSection(
  config: MobileConfig,
  type: MobileSection["type"],
): MobileConfig {
  const copy = structuredClone(config),
    id = `section_${crypto.randomUUID().slice(0, 8)}`,
    key = `${id}_title`;
  const props =
    type === "heroBanner"
      ? {
          imageAssetId: copy.brand.logoAssetId,
          accessibilityLabelKey: key,
          action: { type: "openTab", tab: "categories" },
        }
      : type === "productGrid"
        ? { collectionId: "featured", titleKey: key, columns: 2 }
        : type === "productCarousel"
          ? { collectionId: "featured", titleKey: key }
          : type === "categoryGrid"
            ? { categoryIds: ["featured"], titleKey: key }
            : type === "richText"
              ? { textKey: key }
              : { size: "medium" };
  copy.screens.home.sections.push({ id, type, props } as MobileSection);
  if (type !== "spacer") {
    copy.localization.messages.en = {
      ...copy.localization.messages.en,
      [key]:
        type === "heroBanner"
          ? "Explore our collection"
          : "Discover something new",
    };
    copy.localization.messages.ar = {
      ...copy.localization.messages.ar,
      [key]: "اكتشف مجموعتنا الجديدة",
    };
  }
  return copy;
}
export function moveSection(config: MobileConfig, from: number, to: number) {
  const copy = structuredClone(config),
    sections = copy.screens.home.sections;
  if (from >= 0 && to >= 0 && from < sections.length && to < sections.length)
    sections.splice(to, 0, sections.splice(from, 1)[0]);
  return copy;
}
export interface MobileChange {
  path: string;
  before: string;
  after: string;
}
export function configDiff(
  before: unknown,
  after: unknown,
  path = "",
): MobileChange[] {
  if (canonical(before) === canonical(after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const a = before as Record<string, unknown>,
      b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => k !== "configVersion")
      .flatMap((k) => configDiff(a[k], b[k], `${path}/${k}`));
  }
  const describe = (v: unknown) =>
    v === undefined
      ? "(absent)"
      : typeof v === "string"
        ? v
        : JSON.stringify(v);
  return [
    { path: path || "/", before: describe(before), after: describe(after) },
  ];
}
