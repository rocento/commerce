use crate::{invalid, Error, Issue, Platform, Result, BUILD_SCHEMA, MAX_BYTES, SCHEMA};
use serde_json::Value;
use std::{collections::BTreeSet, sync::LazyLock};
use uuid::Uuid;

static CONFIG: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    jsonschema::validator_for(&serde_json::from_str(SCHEMA).unwrap())
        .expect("embedded mobile schema")
});
static MANIFEST: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    jsonschema::validator_for(&serde_json::from_str(BUILD_SCHEMA).unwrap())
        .expect("embedded build schema")
});
fn shape(value: &Value, schema: &jsonschema::Validator) -> Result<()> {
    if serde_json::to_vec(value).map_err(|_| Error::Storage)?.len() > MAX_BYTES {
        return Err(invalid("", "CONFIG_TOO_LARGE"));
    }
    let issues: Vec<_> = schema
        .iter_errors(value)
        .take(30)
        .map(|error| Issue {
            path: error.instance_path.to_string(),
            code: "SCHEMA_INVALID".into(),
        })
        .collect();
    if !issues.is_empty() {
        return Err(Error::Invalid(issues));
    }
    Ok(())
}
pub fn runtime(value: &str) -> Option<[u32; 3]> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut result = [0; 3];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty()
            || p.len() > 6
            || (p.len() > 1 && p.starts_with('0'))
            || !p.bytes().all(|c| c.is_ascii_digit())
        {
            return None;
        }
        result[i] = p.parse().ok()?;
    }
    Some(result)
}
pub fn banner_layout(config: &Value) -> bool {
    config["screens"]["home"]["sections"]
        .as_array()
        .is_some_and(|sections| {
            sections.iter().any(|s| {
                ["layout", "imageFit", "additionalImageAssetIds"]
                    .iter()
                    .any(|key| s["props"].get(*key).is_some())
            })
        })
}
pub fn editorial(config: &Value) -> bool {
    config["screens"]["home"].get("layout").is_some()
        || config["screens"]["home"]["sections"]
            .as_array()
            .is_some_and(|sections| {
                sections.iter().any(|s| {
                    let p = &s["props"];
                    [
                        "headingKey",
                        "bodyKey",
                        "eyebrowKey",
                        "labelKey",
                        "appearance",
                        "limit",
                        "storefrontPath",
                    ]
                    .iter()
                    .any(|key| p.get(*key).is_some())
                        || p["collectionId"]
                            .as_str()
                            .is_some_and(|id| id.starts_with("demo-feed-"))
                })
            })
}
pub fn deals(config: &Value) -> bool {
    config["navigation"]["tabs"]
        .as_array()
        .is_some_and(|tabs| tabs.iter().any(|tab| tab == "deals"))
        || config["navigation"]["icons"]
            .as_object()
            .is_some_and(|icons| icons.values().any(|icon| icon == "deals"))
        || config["screens"]["home"]["sections"]
            .as_array()
            .is_some_and(|sections| {
                sections
                    .iter()
                    .any(|section| section["props"]["action"]["tab"] == "deals")
            })
}
pub fn compatible(config: &Value, platform: Platform, version: &str) -> bool {
    let field = match platform {
        Platform::Ios => "minIosRuntime",
        Platform::Android => "minAndroidRuntime",
    };
    match (
        runtime(version),
        config["compatibility"][field].as_str().and_then(runtime),
    ) {
        (Some(client), Some(min)) => {
            config["schemaVersion"] == "1.0.0"
                && client[0] == 1
                && min[0] == 1
                && client >= min
                && (config["navigation"].get("icons").is_none() || client >= [1, 1, 0])
                && (!(editorial(config) || deals(config)) || client >= [1, 2, 0])
                && (!banner_layout(config) || client >= [1, 3, 0])
        }
        _ => false,
    }
}
fn luminance(color: &str) -> f64 {
    let channel = |start| {
        let c = u8::from_str_radix(&color[start..start + 2], 16).unwrap() as f64 / 255.;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}
fn contrast(a: &str, b: &str) -> f64 {
    let (a, b) = (luminance(a), luminance(b));
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}
pub fn config(value: &Value, merchant: Uuid) -> Result<()> {
    shape(value, &CONFIG)?;
    if value["tenantId"] != merchant.to_string() {
        return Err(Error::Forbidden);
    }
    for mode in ["light", "dark"] {
        for (fg, bg) in [
            ("onPrimary", "primary"),
            ("text", "background"),
            ("text", "surface"),
        ] {
            if contrast(
                value["brand"][mode][fg].as_str().unwrap(),
                value["brand"][mode][bg].as_str().unwrap(),
            ) < 4.5
            {
                return Err(invalid(
                    &format!("/brand/{mode}/{fg}"),
                    "INSUFFICIENT_CONTRAST",
                ));
            }
        }
    }
    if banner_layout(value)
        && ["minIosRuntime", "minAndroidRuntime"].iter().any(|key| {
            value["compatibility"][*key]
                .as_str()
                .and_then(runtime)
                .is_none_or(|v| v < [1, 3, 0])
        })
    {
        return Err(invalid("/compatibility", "BANNER_RUNTIME_REQUIRED"));
    }
    if editorial(value)
        && ["minIosRuntime", "minAndroidRuntime"].iter().any(|key| {
            value["compatibility"][*key]
                .as_str()
                .and_then(runtime)
                .is_none_or(|v| v < [1, 2, 0])
        })
    {
        return Err(invalid("/compatibility", "EDITORIAL_RUNTIME_REQUIRED"));
    }
    if deals(value)
        && ["minIosRuntime", "minAndroidRuntime"].iter().any(|key| {
            value["compatibility"][*key]
                .as_str()
                .and_then(runtime)
                .is_none_or(|v| v < [1, 2, 0])
        })
    {
        return Err(invalid("/compatibility", "DEALS_RUNTIME_REQUIRED"));
    }
    // Runtime 1.1 adds configurable navigation icons on both native platforms.
    for platform in [Platform::Ios, Platform::Android] {
        if !compatible(value, platform, "1.3.0") {
            return Err(invalid("/compatibility", "UNSUPPORTED_RUNTIME"));
        }
    }
    if value["navigation"].get("icons").is_some() {
        for field in ["minIosRuntime", "minAndroidRuntime"] {
            if value["compatibility"][field].as_str().and_then(runtime) < Some([1, 1, 0]) {
                return Err(invalid("/compatibility", "ICON_RUNTIME_REQUIRED"));
            }
        }
    }
    let tabs = value["navigation"]["tabs"].as_array().unwrap();
    for required in ["home", "cart", "account"] {
        if !tabs.contains(&Value::from(required)) {
            return Err(invalid("/navigation/tabs", "REQUIRED_TAB"));
        }
    }
    if tabs.contains(&Value::from("wishlist")) && value["features"]["wishlist"] != true {
        return Err(invalid("/navigation/tabs", "FEATURE_DISABLED"));
    }
    let locales = value["localization"]["supportedLocales"]
        .as_array()
        .unwrap();
    if !locales.contains(&value["localization"]["defaultLocale"]) {
        return Err(invalid("/localization/defaultLocale", "UNSUPPORTED_LOCALE"));
    }
    if locales.contains(&Value::from("ar")) && value["localization"]["rtlEnabled"] != true {
        return Err(invalid("/localization/rtlEnabled", "RTL_REQUIRED"));
    }
    let mut ids = BTreeSet::new();
    for section in value["screens"]["home"]["sections"].as_array().unwrap() {
        if !ids.insert(section["id"].as_str().unwrap()) {
            return Err(invalid("/screens/home/sections", "DUPLICATE_SECTION_ID"));
        }
        let props = &section["props"];
        if props["action"]["type"] == "openTab" && !tabs.contains(&props["action"]["tab"]) {
            return Err(invalid("/screens/home/sections", "UNKNOWN_TAB"));
        }
        for key in [
            "titleKey",
            "textKey",
            "accessibilityLabelKey",
            "headingKey",
            "bodyKey",
            "eyebrowKey",
            "labelKey",
        ] {
            if let Some(key) = props[key].as_str() {
                for locale in locales {
                    if !value["localization"]["messages"][locale.as_str().unwrap()][key].is_string()
                    {
                        return Err(invalid("/localization/messages", "MISSING_TRANSLATION"));
                    }
                }
            }
        }
    }
    Ok(())
}
pub fn assets(value: &Value) -> BTreeSet<Uuid> {
    let mut result = BTreeSet::new();
    if let Some(id) = value["brand"]["logoAssetId"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
    {
        result.insert(id);
    }
    if let Some(sections) = value["screens"]["home"]["sections"].as_array() {
        for section in sections {
            if let Some(ids) = section["props"]["additionalImageAssetIds"].as_array() {
                result.extend(
                    ids.iter()
                        .filter_map(|id| id.as_str().and_then(|v| Uuid::parse_str(v).ok())),
                );
            }
            if let Some(id) = section["props"]["imageAssetId"]
                .as_str()
                .and_then(|v| Uuid::parse_str(v).ok())
            {
                result.insert(id);
            }
        }
    }
    result
}
pub fn manifest(value: &Value, merchant: Uuid) -> Result<()> {
    shape(value, &MANIFEST)?;
    if value["merchantId"] != merchant.to_string() {
        return Err(Error::Forbidden);
    }
    if value["runtimeVersion"] != "1.0.0"
        && value["runtimeVersion"] != "1.1.0"
        && value["runtimeVersion"] != "1.2.0"
        && value["runtimeVersion"] != "1.3.0"
    {
        return Err(invalid("/runtimeVersion", "UNSUPPORTED_RUNTIME"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../contract/v1/fixtures/merchant-1.json")).unwrap()
    }
    #[test]
    fn banner_layout_runtime_and_asset_ownership() {
        let mut v: Value =
            serde_json::from_str(include_str!("../contract/v1/fixtures/merchant-1.json")).unwrap();
        let props = &mut v["screens"]["home"]["sections"][0]["props"];
        props["layout"] = serde_json::json!("portrait");
        props["additionalImageAssetIds"] =
            serde_json::json!(["d3d03c49-c514-40fc-b251-cc6bf3b71903"]);
        v["compatibility"] =
            serde_json::json!({"minIosRuntime":"1.3.0","minAndroidRuntime":"1.3.0"});
        assert!(compatible(&v, Platform::Ios, "1.3.0"));
        assert!(!compatible(&v, Platform::Ios, "1.2.0"));
        assert!(
            assets(&v).contains(&Uuid::parse_str("d3d03c49-c514-40fc-b251-cc6bf3b71903").unwrap())
        );
        assert!(shape(&v, &CONFIG).is_ok());
        v["screens"]["home"]["sections"][0]["props"]["layout"] = serde_json::json!("unknown");
        assert!(shape(&v, &CONFIG).is_err());
    }

    #[test]
    fn editorial_layout_requires_new_runtime_and_complete_copy() {
        let mut v = fixture();
        let id = Uuid::parse_str(v["tenantId"].as_str().unwrap()).unwrap();
        v["screens"]["home"]["layout"] = Value::from("storefront");
        assert!(config(&v, id).is_err());
        assert!(!compatible(&v, Platform::Ios, "1.1.0"));
        v["compatibility"] =
            serde_json::json!({"minIosRuntime":"1.2.0","minAndroidRuntime":"1.2.0"});
        config(&v, id).unwrap();
        v["screens"]["home"]["sections"][0]["props"]["headingKey"] = Value::from("missing-copy");
        assert!(config(&v, id).is_err());
    }
    #[test]
    fn deals_require_runtime_12_even_when_minimum_is_downgraded() {
        for icons_only in [false, true] {
            let mut v = fixture();
            let id = Uuid::parse_str(v["tenantId"].as_str().unwrap()).unwrap();
            if icons_only {
                v["navigation"]["icons"] = serde_json::json!({"home":"deals"});
            } else {
                v["navigation"]["tabs"] =
                    serde_json::json!(["home", "categories", "deals", "account", "cart"]);
            }
            assert!(config(&v, id).is_err());
            assert!(!compatible(&v, Platform::Ios, "1.1.0"));
            assert!(!compatible(&v, Platform::Android, "1.1.0"));
            v["compatibility"] =
                serde_json::json!({"minIosRuntime":"1.2.0","minAndroidRuntime":"1.2.0"});
            config(&v, id).unwrap();
            assert!(compatible(&v, Platform::Ios, "1.2.0"));
            assert!(compatible(&v, Platform::Android, "1.2.0"));
        }
    }
    #[test]
    fn configurable_icons_require_new_runtime() {
        let mut v = fixture();
        let id = Uuid::parse_str(v["tenantId"].as_str().unwrap()).unwrap();
        assert!(compatible(&v, Platform::Ios, "1.0.0"));
        v["navigation"]["icons"] = serde_json::json!({"home": "location", "cart": "wishlist"});
        assert!(config(&v, id).is_err());
        for platform in [Platform::Ios, Platform::Android] {
            assert!(!compatible(&v, platform, "1.0.0"));
        }
        v["compatibility"] =
            serde_json::json!({"minIosRuntime":"1.1.0", "minAndroidRuntime":"1.1.0"});
        config(&v, id).unwrap();
        for platform in [Platform::Ios, Platform::Android] {
            assert!(compatible(&v, platform, "1.1.0"));
        }
        v["navigation"]["icons"]["home"] = Value::from("arbitrary-svg");
        assert!(config(&v, id).is_err());
        v["navigation"]["icons"] = serde_json::json!({"unknown-tab":"home"});
        assert!(config(&v, id).is_err());
    }
    #[test]
    fn product_action_visibility_is_optional_and_boolean() {
        let mut value = fixture();
        let id = Uuid::parse_str(value["tenantId"].as_str().unwrap()).unwrap();
        config(&value, id).unwrap();
        value["screens"]["product"] =
            serde_json::json!({"showWishlist": false, "showCompare": true});
        config(&value, id).unwrap();
        value["screens"]["product"]["showCompare"] = Value::from("false");
        assert!(config(&value, id).is_err());
    }

    #[test]
    fn fixtures_and_guards() {
        let base = fixture();
        let id = Uuid::parse_str(base["tenantId"].as_str().unwrap()).unwrap();
        config(&base, id).unwrap();
        let other: Value =
            serde_json::from_str(include_str!("../contract/v1/fixtures/merchant-2.json")).unwrap();
        config(
            &other,
            Uuid::parse_str(other["tenantId"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            config(&base, Uuid::new_v4()),
            Err(Error::Forbidden)
        ));
        for (path, replacement) in [
            ("/brand/light/onPrimary", Value::from("#1263DF")),
            ("/screens/home/sections/0/type", Value::from("webView")),
            (
                "/screens/home/sections/0/props/action/type",
                Value::from("executeScript"),
            ),
            ("/brand/fontToken", Value::from("downloaded")),
            ("/compatibility/minIosRuntime", Value::from("2.0.0")),
            ("/localization/rtlEnabled", Value::from(false)),
            (
                "/localization/messages/ar/hero_label",
                Value::from("<script>alert(1)</script>"),
            ),
        ] {
            let mut v = base.clone();
            *v.pointer_mut(path).unwrap() = replacement;
            assert!(config(&v, id).is_err(), "{path}");
        }
        let mut v = base.clone();
        v["screens"]["home"]["sections"][0]["props"]["url"] = Value::from("https://evil.test");
        assert!(config(&v, id).is_err());
        let mut v = base.clone();
        v["screens"]["home"]["sections"][1]["id"] =
            v["screens"]["home"]["sections"][0]["id"].clone();
        assert!(config(&v, id).is_err());
        let mut v = base.clone();
        v["localization"]["messages"]["ar"]
            .as_object_mut()
            .unwrap()
            .remove("featured_title");
        assert!(config(&v, id).is_err());
    }
    #[test]
    fn runtime_comparison_is_numeric_and_fail_closed() {
        let v = fixture();
        assert!(compatible(&v, Platform::Ios, "1.10.0"));
        for runtime in [
            "0.9.0",
            "2.0.0",
            "01.0.0",
            "1.0",
            "1.0.0-beta",
            "9999999.0.0",
            "1.+0.0",
        ] {
            assert!(!compatible(&v, Platform::Ios, runtime), "{runtime}");
        }
    }
}
