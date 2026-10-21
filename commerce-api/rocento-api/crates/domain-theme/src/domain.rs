use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const MAX_BYTES: usize = 128 * 1024;
pub const CONTRACT: &str = include_str!("../../../theme-contract.json");

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ThemeNotFound")]
    NotFound,
    #[error("ThemeVersionConflict: reload the theme before saving")]
    Conflict,
    #[error("ThemeAccessDenied")]
    Forbidden,
    #[error("InvalidThemeConfiguration: {0}")]
    Invalid(String),
    #[error("ThemeStorageUnavailable")]
    Storage,
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    pub schema_version: String,
    pub tokens: BTreeMap<String, Value>,
    pub global: BTreeMap<String, Vec<Section>>,
    pub pages: BTreeMap<String, Vec<Section>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub id: String,
    pub component: String,
    pub version: u32,
    pub enabled: bool,
    pub settings: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub translations: BTreeMap<String, BTreeMap<String, Translation>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Translation {
    pub source: String,
    pub value: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Property {
    pub kind: String,
    pub default: Value,
    pub min: Option<u32>,
    pub max: Option<u32>,
    pub options: Option<Vec<String>>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Definition {
    pub label: String,
    pub version: u32,
    pub locations: Vec<String>,
    pub required: bool,
    pub settings: BTreeMap<String, Property>,
}
#[derive(Deserialize, Serialize)]
pub struct Contract {
    pub schema_version: String,
    pub tokens: BTreeMap<String, Property>,
    pub components: BTreeMap<String, Definition>,
    pub default: Configuration,
}
pub fn contract() -> &'static Contract {
    static VALUE: std::sync::OnceLock<Contract> = std::sync::OnceLock::new();
    VALUE.get_or_init(|| serde_json::from_str(CONTRACT).expect("bundled theme contract"))
}
pub fn default_configuration() -> Configuration {
    contract().default.clone()
}
pub fn safe_link(s: &str) -> bool {
    s.len() <= 2000
        && s.starts_with('/')
        && !s.starts_with("//")
        && !s.contains(['\\', '%'])
        && !s.chars().any(|c| c.is_control() || c.is_whitespace())
}
fn property_valid(p: &Property, v: &Value) -> bool {
    match p.kind.as_str() {
        "color" => v.as_str().is_some_and(|s| {
            s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|c| c.is_ascii_hexdigit())
        }),
        "number" => v
            .as_u64()
            .is_some_and(|n| n >= p.min.unwrap_or(0) as u64 && n <= p.max.unwrap_or(4096) as u64),
        "select" => v
            .as_str()
            .is_some_and(|s| p.options.as_ref().is_some_and(|o| o.iter().any(|x| x == s))),
        "link" => v.as_str().is_some_and(safe_link),
        "asset" => v.is_null() || v.as_str().is_some_and(|s| Uuid::parse_str(s).is_ok()),
        "text" => v.as_str().is_some_and(|s| {
            s.len() <= p.max.unwrap_or(200) as usize
                && s.len() >= p.min.unwrap_or(0) as usize
                && !s.contains(['<', '>'])
                && !s.chars().any(|c| c.is_control() && c != '\n')
        }),
        _ => false,
    }
}
fn validate_properties(
    properties: &BTreeMap<String, Property>,
    values: &BTreeMap<String, Value>,
    path: &str,
) -> Result<()> {
    if properties.len() != values.len() {
        return Err(Error::Invalid(format!(
            "{path}: missing or unknown settings"
        )));
    }
    for (key, value) in values {
        if !properties
            .get(key)
            .is_some_and(|p| property_valid(p, value))
        {
            return Err(Error::Invalid(format!("{path}.{key}")));
        }
    }
    Ok(())
}
fn valid_translation_locale(locale: &str) -> bool {
    let parts: Vec<_> = locale.split('-').collect();
    if !(2..=3).contains(&parts[0].len()) || !parts[0].bytes().all(|b| b.is_ascii_lowercase()) {
        return false;
    }
    let mut index = 1;
    if parts.get(index).is_some_and(|p| p.len() == 4) {
        let script = parts[index].as_bytes();
        if !script[0].is_ascii_uppercase() || !script[1..].iter().all(u8::is_ascii_lowercase) {
            return false;
        }
        index += 1;
    }
    if let Some(region) = parts.get(index) {
        if !((region.len() == 2 && region.bytes().all(|b| b.is_ascii_uppercase()))
            || (region.len() == 3 && region.bytes().all(|b| b.is_ascii_digit())))
        {
            return false;
        }
        index += 1;
    }
    index == parts.len()
}
impl Configuration {
    pub fn validate_translations_for_publication(&self) -> Result<()> {
        for section in self.global.values().chain(self.pages.values()).flatten() {
            for (locale, fields) in &section.translations {
                for (key, field) in fields {
                    if section
                        .settings
                        .get(key)
                        .or_else(|| {
                            (section.component == "footer_options")
                                .then(|| {
                                    contract().components["footer_options"]
                                        .settings
                                        .get(key)
                                        .map(|p| &p.default)
                                })
                                .flatten()
                        })
                        .and_then(Value::as_str)
                        != Some(field.source.as_str())
                    {
                        return Err(Error::Invalid(format!("{locale}.{}.{key}: source changed; review translation before publication", section.id)));
                    }
                }
            }
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        let c = contract();
        if self.schema_version != c.schema_version {
            return Err(Error::Invalid("unsupported schema version".into()));
        }
        if serde_json::to_vec(self).map_err(|_| Error::Storage)?.len() > MAX_BYTES {
            return Err(Error::Invalid("configuration exceeds 128 KiB".into()));
        }
        // New layout settings are optional for previously published configurations.
        let mut tokens = self.tokens.clone();
        for key in [
            "grid.columns.desktop",
            "grid.columns.tablet",
            "grid.columns.mobile",
            "layout.direction",
            "font.arabic.body",
            "font.arabic.heading",
            "font.size-offset",
        ] {
            tokens
                .entry(key.into())
                .or_insert_with(|| c.tokens[key].default.clone());
        }
        validate_properties(&c.tokens, &tokens, "tokens")?;
        let number = |key: &str| self.tokens[key].as_u64().unwrap_or(0);
        if number("breakpoint.mobile") >= number("breakpoint.desktop") {
            return Err(Error::Invalid("breakpoints must increase".into()));
        }
        if self.global.keys().map(String::as_str).collect::<Vec<_>>() != ["bottom", "top"]
            || self.pages.keys().map(String::as_str).collect::<Vec<_>>()
                != ["cart", "category", "home", "product", "search"]
        {
            return Err(Error::Invalid("required layouts are missing".into()));
        }
        let mut ids = BTreeSet::new();
        for (location, sections) in self.global.iter().chain(self.pages.iter()) {
            if sections.len() > 30 {
                return Err(Error::Invalid("at most 30 sections per layout".into()));
            }
            for s in sections {
                if s.id.is_empty()
                    || s.id.len() > 80
                    || !s.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    || !ids.insert(&s.id)
                {
                    return Err(Error::Invalid(
                        "section IDs must be unique identifiers".into(),
                    ));
                }
                let d = c
                    .components
                    .get(&s.component)
                    .ok_or_else(|| Error::Invalid(format!("UnknownComponent: {}", s.component)))?;
                if s.version != d.version || !d.locations.contains(location) {
                    return Err(Error::Invalid(format!(
                        "{}: unsupported version or location",
                        s.id
                    )));
                }
                if d.required && !s.enabled {
                    return Err(Error::Invalid(format!(
                        "{} cannot be disabled",
                        s.component
                    )));
                }
                let mut settings = s.settings.clone();
                if s.component == "footer_options" {
                    for (key, property) in &d.settings {
                        if key == "back_to_top_label" || key.starts_with("install_") {
                            settings
                                .entry(key.clone())
                                .or_insert_with(|| property.default.clone());
                        }
                    }
                }
                validate_properties(&d.settings, &settings, &s.id)?;
                if s.translations.len() > 32 {
                    return Err(Error::Invalid(
                        "at most 32 translation locales per section".into(),
                    ));
                }
                for (locale, fields) in &s.translations {
                    if !valid_translation_locale(locale) {
                        return Err(Error::Invalid("invalid translation locale".into()));
                    }
                    for (key, field) in fields {
                        let p = d
                            .settings
                            .get(key)
                            .ok_or_else(|| Error::Invalid("unknown translation setting".into()))?;
                        let mut source_property = p.clone();
                        source_property.min = Some(0);
                        if p.kind != "text"
                            || key == "query"
                            || field.value.trim().is_empty()
                            || !property_valid(p, &Value::String(field.value.clone()))
                            || !property_valid(
                                &source_property,
                                &Value::String(field.source.clone()),
                            )
                        {
                            return Err(Error::Invalid(format!(
                                "{}.translations.{locale}.{key}",
                                s.id
                            )));
                        }
                    }
                }
                if s.settings.get("image").is_some_and(|v| !v.is_null())
                    && s.settings
                        .get("alt")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .is_empty()
                {
                    return Err(Error::Invalid(format!("{}: image alt text required", s.id)));
                }
            }
            for (kind, d) in &c.components {
                if d.required
                    && d.locations.contains(location)
                    && sections.iter().filter(|s| &s.component == kind).count() != 1
                {
                    return Err(Error::Invalid(format!(
                        "{location} requires exactly one {kind}"
                    )));
                }
            }
        }
        Ok(())
    }
    pub fn assets(&self) -> Vec<Uuid> {
        self.global
            .values()
            .chain(self.pages.values())
            .flatten()
            .filter_map(|s| {
                s.settings
                    .get("image")
                    .and_then(Value::as_str)
                    .and_then(|v| Uuid::parse_str(v).ok())
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Theme {
    pub id: Uuid,
    pub entity_id: i64,
    pub name: String,
    pub owner_channel: String,
    pub revision: i32,
    pub configuration: Configuration,
    pub published_version: Option<Uuid>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Version {
    pub id: Uuid,
    pub entity_id: i64,
    pub theme_id: Uuid,
    pub number: i32,
    pub configuration: Configuration,
    pub created_by: Uuid,
    pub published_at: chrono::DateTime<chrono::Utc>,
    pub source_version: Option<Uuid>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translation_drafts_preserve_snapshots_and_gate_stale_publication() {
        let mut config = default_configuration();
        let hero = &mut config.pages.get_mut("home").unwrap()[0];
        hero.translations.insert(
            "ar".into(),
            BTreeMap::from([(
                "heading".into(),
                Translation {
                    source: hero.settings["heading"].as_str().unwrap().into(),
                    value: "اختيارات طازجة".into(),
                },
            )]),
        );
        config.validate().unwrap();
        config.validate_translations_for_publication().unwrap();
        let published = serde_json::to_vec(&config).unwrap();
        config.pages.get_mut("home").unwrap()[0]
            .settings
            .insert("heading".into(), "Changed source".into());
        config.validate().unwrap();
        assert!(config.validate_translations_for_publication().is_err());
        let restored: Configuration = serde_json::from_slice(&published).unwrap();
        restored.validate_translations_for_publication().unwrap();
        assert_eq!(
            restored.pages["home"][0].translations["ar"]["heading"].value,
            "اختيارات طازجة"
        );
    }
    #[test]
    fn translation_validation_rejects_unsafe_text_and_behavior_overrides() {
        for (key, value) in [
            ("href", "/safe"),
            ("image", "asset"),
            ("heading", "<script>"),
            ("heading", " "),
            ("unknown", "text"),
        ] {
            let mut config = default_configuration();
            config.pages.get_mut("home").unwrap()[0]
                .translations
                .insert(
                    "ar".into(),
                    BTreeMap::from([(
                        key.into(),
                        Translation {
                            source: "source".into(),
                            value: value.into(),
                        },
                    )]),
                );
            assert!(config.validate().is_err(), "{key}:{value}");
        }
        for locale in ["ar", "en-GB", "zh-Hant", "zh-Hant-TW", "es-419"] {
            assert!(valid_translation_locale(locale));
        }
        for locale in ["", "EN", "ar-eg", "../ar", "ar-EG-extra"] {
            assert!(!valid_translation_locale(locale));
        }
    }
    #[test]
    fn arabic_fonts_preserve_legacy_themes_and_validate_choices() {
        let mut config = default_configuration();
        config.validate().unwrap();
        for font in ["inherit", "Cairo", "Tajawal", "Noto Sans Arabic"] {
            config.tokens.insert("font.arabic.body".into(), font.into());
            config
                .tokens
                .insert("font.arabic.heading".into(), font.into());
            config.validate().unwrap();
        }
        config
            .tokens
            .insert("font.arabic.body".into(), "Cairo;display:none".into());
        assert!(config.validate().is_err());
    }
    #[test]
    fn responsive_columns_are_optional_and_bounded() {
        default_configuration().validate().unwrap();
        for value in [
            serde_json::json!(0),
            serde_json::json!(7),
            serde_json::json!(2.5),
        ] {
            let mut config = default_configuration();
            config.tokens.insert("grid.columns.mobile".into(), value);
            assert!(config.validate().is_err());
        }
        let mut config = default_configuration();
        config
            .tokens
            .insert("grid.columns.desktop".into(), serde_json::json!(5));
        config.validate().unwrap();
    }
    #[test]
    fn direction_is_optional_and_allowlisted() {
        let mut config = default_configuration();
        config.tokens.remove("layout.direction");
        config.validate().unwrap();
        for direction in ["ltr", "rtl"] {
            config
                .tokens
                .insert("layout.direction".into(), direction.into());
            config.validate().unwrap();
        }
        for direction in [
            serde_json::json!("auto"),
            serde_json::json!("rtl;display:none"),
            serde_json::json!(1),
            Value::Null,
        ] {
            config.tokens.insert("layout.direction".into(), direction);
            assert!(config.validate().is_err());
        }
    }
    #[test]
    fn legacy_footer_accepts_new_text_and_gates_stale_translations() {
        let mut config = default_configuration();
        let settings = contract().components["footer_options"]
            .settings
            .iter()
            .filter(|(key, _)| key.as_str() != "back_to_top_label" && !key.starts_with("install_"))
            .map(|(key, p)| (key.clone(), p.default.clone()))
            .collect();
        let section = Section {
            id: "legacy-footer-options".into(),
            component: "footer_options".into(),
            version: 1,
            enabled: true,
            settings,
            translations: BTreeMap::from([(
                "ar".into(),
                BTreeMap::from([(
                    "back_to_top_label".into(),
                    Translation {
                        source: "Back to top".into(),
                        value: "العودة إلى الأعلى".into(),
                    },
                )]),
            )]),
        };
        config.global.get_mut("bottom").unwrap().push(section);
        config.validate().unwrap();
        config.validate_translations_for_publication().unwrap();
        config
            .global
            .get_mut("bottom")
            .unwrap()
            .last_mut()
            .unwrap()
            .settings
            .insert("back_to_top_label".into(), "Return to start".into());
        config.validate().unwrap();
        assert!(config.validate_translations_for_publication().is_err());
    }

    #[test]
    fn reference_theme_is_valid() {
        default_configuration().validate().unwrap();
    }
    #[test]
    fn rejects_injection_and_unknown_tokens() {
        for value in [
            "red; background:url(javascript:alert(1))",
            "#fff",
            "</style>",
        ] {
            let mut c = default_configuration();
            c.tokens.insert("color.primary".into(), value.into());
            assert!(c.validate().is_err());
        }
        for link in [
            "//evil.com",
            "/\\evil",
            "javascript:alert(1)",
            "/%2fexample.com",
            "/x\n",
        ] {
            assert!(!safe_link(link));
        }
    }
    #[test]
    fn rejects_unknown_components_and_broken_commerce_layouts() {
        let mut c = default_configuration();
        c.pages.get_mut("cart").unwrap().clear();
        assert!(c.validate().is_err());
        let mut c = default_configuration();
        c.pages.get_mut("home").unwrap()[0].component = "import-module".into();
        assert!(c.validate().is_err());
        let mut c = default_configuration();
        c.pages.get_mut("product").unwrap()[0].enabled = false;
        assert!(c.validate().is_err());
    }
}
