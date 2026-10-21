//! Localized search aliases share the same product document and commerce constraints.
use domain_catalog::{Definition, Product, SearchTranslation};

pub(super) fn normalize_arabic(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            '\u{0640}' | '\u{064b}'..='\u{065f}' | '\u{0670}' => None,
            'أ' | 'إ' | 'آ' | 'ٱ' => Some('ا'),
            'ى' => Some('ي'),
            'ة' => Some('ه'),
            '٠'..='٩' => char::from_u32('0' as u32 + c as u32 - '٠' as u32),
            '۰'..='۹' => char::from_u32('0' as u32 + c as u32 - '۰' as u32),
            _ => Some(c),
        })
        .collect()
}

#[derive(Default)]
pub(super) struct SearchCopy {
    pub names: Vec<String>,
    pub descriptions: Vec<String>,
    pub attributes: Vec<String>,
}

pub(super) fn search_copy(
    product: &Product,
    children: &[Product],
    definitions: &[Definition],
    translations: &[SearchTranslation],
    definition_translations: &[SearchTranslation],
) -> SearchCopy {
    let mut copy = SearchCopy::default();
    for source in std::iter::once(product).chain(children.iter()) {
        // Include source aliases too, for stores whose source language is Arabic.
        copy.names.push(normalize_arabic(&source.name));
        copy.descriptions
            .push(normalize_arabic(&source.description));
        for translation in translations.iter().filter(|t| t.entity_id == source.id) {
            for key in ["name", "description"] {
                if let Some(text) = translation.fields[key]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                {
                    if key == "name" {
                        copy.names.push(normalize_arabic(text));
                    } else {
                        copy.descriptions.push(normalize_arabic(text));
                    }
                }
            }
            for definition in definitions
                .iter()
                .filter(|d| d.metadata.active() && d.is_visible_on_front && d.is_searchable)
            {
                // Match the public projection: translations cannot create a missing
                // attribute or expose a hidden/non-text value.
                if source.attributes[&definition.attribute_code].is_string() {
                    let key = format!("attribute.{}", definition.attribute_code);
                    if let Some(text) = translation.fields[&key].as_str() {
                        copy.attributes.push(normalize_arabic(text));
                    }
                }
            }
        }
        for definition in definitions
            .iter()
            .filter(|d| d.metadata.active() && d.is_visible_on_front && d.is_searchable)
        {
            let Some(value) = source.attributes.get(&definition.attribute_code) else {
                continue;
            };
            for option in definition.options.as_array().into_iter().flatten() {
                if value != &option["value"]
                    && !value
                        .as_array()
                        .is_some_and(|values| values.contains(&option["value"]))
                {
                    continue;
                }
                let Some(option_value) = option["value"].as_str() else {
                    continue;
                };
                let key = format!("option.{option_value}");
                for translation in definition_translations
                    .iter()
                    .filter(|t| t.entity_id == definition.id)
                {
                    if let Some(text) = translation.fields[&key].as_str() {
                        copy.attributes.push(normalize_arabic(text));
                    }
                }
            }
        }
    }
    for values in [
        &mut copy.names,
        &mut copy.descriptions,
        &mut copy.attributes,
    ] {
        values.retain(|text| !text.trim().is_empty());
        values.sort();
        values.dedup();
    }
    copy
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    fn product() -> Product {
        serde_json::from_value(json!({
            "id":Uuid::new_v4(),"sku":"TEA-1","slug":"tea","name":"Green tea",
            "description":"Loose leaf tea","price":"10.00","currency":"EGP","unit":"each",
            "category_id":Uuid::new_v4(),"attributes":{"brand":"Garden","private":"internal","color":["green"]},
            "media_ids":[],"active":true,"in_stock":true,"updated_at":"2026-10-03T00:00:00Z"
        })).unwrap()
    }

    fn definition(code: &str, visible: bool) -> Definition {
        serde_json::from_value(json!({
            "id":Uuid::new_v4(),"entity_type":"product","attribute_code":code,"label":code,
            "input_type":"text","scope":"global","is_required":false,"is_unique":false,
            "is_searchable":true,"is_filterable":false,"is_comparable":false,"is_visible_on_front":visible,
            "used_for_promo_rules":false,"used_for_configurations":false,"swatch_type":"none",
            "options":[],"version":1
        })).unwrap()
    }

    #[test]
    fn arabic_variants_and_numerals_share_a_query_without_changing_english() {
        assert_eq!(normalize_arabic("شَـاي أَخْضَر ١٢۳"), "شاي اخضر 123");
        assert_eq!(normalize_arabic("إبرة آمنة ٱلأرز على"), "ابره امنه الارز علي");
        assert_eq!(normalize_arabic("TEA-123 green tea"), "TEA-123 green tea");
    }

    #[test]
    fn indexes_localized_copy_without_hidden_or_missing_attributes() {
        let product = product();
        let mut disabled = definition("disabled", true);
        disabled.is_searchable = false;
        let definitions = vec![
            definition("brand", true),
            definition("private", false),
            definition("missing", true),
            disabled,
        ];
        let translation = SearchTranslation {
            entity_id: product.id,
            fields: json!({
                "name":"شَاي أَخْضَر","description":"أوراق شاي طازجة","attribute.brand":"الحديقة",
                "attribute.private":"سري","attribute.missing":"مفقود","attribute.disabled":"معطل","price":"١"
            }),
        };
        let copy = search_copy(&product, &[], &definitions, &[translation], &[]);
        assert!(copy.names.contains(&"Green tea".into()));
        assert!(copy.names.contains(&"شاي اخضر".into()));
        assert!(copy.descriptions.contains(&"اوراق شاي طازجه".into()));
        assert_eq!(copy.attributes, vec!["الحديقه"]);
    }

    #[test]
    fn indexes_child_copy_and_only_assigned_localized_option_labels() {
        let parent = product();
        let child = product();
        let mut color = definition("color", true);
        color.options = json!([{"value":"green","label":"Green"},{"value":"red","label":"Red"}]);
        let translation = SearchTranslation {
            entity_id: color.id,
            fields: json!({"option.green":"أخضر","option.red":"أحمر"}),
        };
        let copy = search_copy(
            &parent,
            std::slice::from_ref(&child),
            &[color],
            &[
                SearchTranslation {
                    entity_id: child.id,
                    fields: json!({"name":"شاي بالنعناع"}),
                },
                SearchTranslation {
                    entity_id: Uuid::new_v4(),
                    fields: json!({"name":"منتج آخر"}),
                },
            ],
            &[translation],
        );
        assert!(copy.names.contains(&"شاي بالنعناع".into()));
        assert!(!copy.names.contains(&"منتج اخر".into()));
        assert_eq!(copy.attributes, vec!["اخضر"]);
    }
}
