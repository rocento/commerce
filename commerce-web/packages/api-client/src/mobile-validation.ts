import validate from "./mobile-validator.generated.js";
import type { MobileConfig, MobileIssue } from "./mobile";
function luminance(hex: string) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function mobileConfigIssues(
  value: unknown,
  merchant: string,
  entitlements: Record<string, boolean>,
): MobileIssue[] {
  if (!validate(value))
    return (validate.errors || [])
      .slice(0, 30)
      .map((e) => ({
        path: e.instancePath,
        code: `SCHEMA_INVALID: ${e.message}`,
      }));
  const issues: MobileIssue[] = [];
  const issue = (path: string, code: string) => issues.push({ path, code });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 128 * 1024)
    issue("", "CONFIG_TOO_LARGE");
  if (value.tenantId !== merchant) issue("/tenantId", "MERCHANT_MISMATCH");
  for (const mode of ["light", "dark"] as const) {
    const p = value.brand[mode];
    for (const [fg, bg] of [
      ["onPrimary", "primary"],
      ["text", "background"],
      ["text", "surface"],
    ] as const) {
      const a = luminance(p[fg]),
        b = luminance(p[bg]);
      if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 4.5)
        issue(`/brand/${mode}/${fg}`, "INSUFFICIENT_CONTRAST");
    }
  }
  if (
    !["1.0.0", "1.1.0", "1.2.0", "1.3.0"].includes(value.compatibility.minIosRuntime) ||
    !["1.0.0", "1.1.0", "1.2.0", "1.3.0"].includes(value.compatibility.minAndroidRuntime)
  )
    issue("/compatibility", "UNSUPPORTED_RUNTIME");
  if (value.navigation.icons && (
    value.compatibility.minIosRuntime === "1.0.0" ||
    value.compatibility.minAndroidRuntime === "1.0.0"
  )) issue("/compatibility", "ICON_RUNTIME_REQUIRED");
  for (const feature of Object.keys(
    value.features,
  ) as (keyof MobileConfig["features"])[])
    if (value.features[feature] && !entitlements[feature])
      issue(`/features/${feature}`, "NOT_ENTITLED");
  const banners = value.screens.home.sections.some(s => s.type === 'heroBanner' && (s.props.layout !== undefined || s.props.imageFit !== undefined || s.props.additionalImageAssetIds !== undefined));
  if (banners && (value.compatibility.minIosRuntime !== '1.3.0' || value.compatibility.minAndroidRuntime !== '1.3.0')) issue('/compatibility', 'BANNER_RUNTIME_REQUIRED');
  const editorial = value.screens.home.layout !== undefined || value.screens.home.sections.some(s => Object.keys(s.props).some(key => ["headingKey", "bodyKey", "eyebrowKey", "labelKey", "appearance", "limit", "storefrontPath"].includes(key)) || ("collectionId" in s.props && s.props.collectionId.startsWith("demo-feed-")));
  if (editorial && (!["1.2.0", "1.3.0"].includes(value.compatibility.minIosRuntime) || !["1.2.0", "1.3.0"].includes(value.compatibility.minAndroidRuntime))) issue("/compatibility", "EDITORIAL_RUNTIME_REQUIRED");
  const deals = value.navigation.tabs.includes("deals") || Object.values(value.navigation.icons || {}).includes("deals") || value.screens.home.sections.some(s => "action" in s.props && s.props.action?.type === "openTab" && s.props.action.tab === "deals");
  if (deals && (!["1.2.0", "1.3.0"].includes(value.compatibility.minIosRuntime) || !["1.2.0", "1.3.0"].includes(value.compatibility.minAndroidRuntime))) issue("/compatibility", "DEALS_RUNTIME_REQUIRED");
  const tabs = value.navigation.tabs;
  for (const tab of ["home", "cart", "account"] as const)
    if (!tabs.includes(tab)) issue("/navigation/tabs", "REQUIRED_TAB");
  if (tabs.includes("wishlist") && !value.features.wishlist)
    issue("/navigation/tabs", "FEATURE_DISABLED");
  const l = value.localization;
  if (!l.supportedLocales.includes(l.defaultLocale))
    issue("/localization/defaultLocale", "UNSUPPORTED_LOCALE");
  if (l.supportedLocales.includes("ar") && !l.rtlEnabled)
    issue("/localization/rtlEnabled", "RTL_REQUIRED");
  const ids = new Set<string>();
  for (const section of value.screens.home.sections) {
    if (ids.has(section.id))
      issue("/screens/home/sections", "DUPLICATE_SECTION_ID");
    ids.add(section.id);
    if (
      "action" in section.props && section.props.action &&
      section.props.action.type === "openTab" &&
      !tabs.includes(section.props.action.tab)
    )
      issue("/screens/home/sections", "UNKNOWN_TAB");
    for (const [key, v] of Object.entries(section.props))
      if (["titleKey", "textKey", "accessibilityLabelKey", "headingKey", "bodyKey", "eyebrowKey", "labelKey"].includes(key))
        for (const locale of l.supportedLocales) {
          if (!l.messages[locale]?.[String(v)])
            issue(
              `/localization/messages/${locale}/${v}`,
              "MISSING_TRANSLATION",
            );
        }
  }
  return issues;
}
