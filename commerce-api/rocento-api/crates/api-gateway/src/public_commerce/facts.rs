//! Public commercial facts are resolved once, inside the publication transaction.
use super::snapshot::Snapshot;
use domain_catalog::public::Product;
use domain_pricing_promotions::{evaluate, Line, Rule};
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::PgConnection;

pub struct Pricing {
    rules: Vec<Rule>,
    ambiguous: bool,
}
impl Pricing {
    pub async fn load(db: &mut PgConnection) -> Result<Self, sqlx::Error> {
        let rules:Vec<Rule>=sqlx::query_as("SELECT * FROM pricing_promotions.rules WHERE active AND (starts_at IS NULL OR starts_at<=transaction_timestamp()) AND (ends_at IS NULL OR ends_at>transaction_timestamp()) ORDER BY priority DESC,id LIMIT 100").fetch_all(&mut *db).await?;
        let conditioned:Vec<uuid::Uuid>=sqlx::query_scalar("SELECT rule_id FROM pricing_promotions.attribute_conditions WHERE conditions<>'{}'::jsonb").fetch_all(db).await?;
        let ambiguous = rules.iter().any(|r| {
            (r.scope == "cart" && r.coupon_code.is_none())
                || (r.scope == "catalog"
                    && (r.customer_group != "all"
                        || r.min_subtotal != Decimal::ZERO
                        || conditioned.contains(&r.id)))
        });
        Ok(Self {
            rules: rules
                .into_iter()
                .filter(|r| {
                    r.scope == "catalog"
                        && r.customer_group == "all"
                        && r.min_subtotal == Decimal::ZERO
                        && !conditioned.contains(&r.id)
                })
                .collect(),
            ambiguous,
        })
    }
    pub fn apply(&self, p: &mut Product) -> Result<(), sqlx::Error> {
        p.offer_eligible = false;
        p.original_price = None;
        p.price_diagnostic = if p.product_type != "simple" {
            "selection_required"
        } else if p.currency != "USD" {
            "unsupported_checkout_currency"
        } else if self.ambiguous {
            "conditional_pricing"
        } else {
            "public_catalog_price"
        }
        .into();
        if p.product_type != "simple" || p.currency != "USD" || self.ambiguous {
            return Ok(());
        }
        let price = p
            .price
            .parse::<Decimal>()
            .map_err(|_| sqlx::Error::Protocol("invalid public price".into()))?;
        if price < Decimal::ZERO {
            return Err(sqlx::Error::Protocol("negative public price".into()));
        }
        let assessed = evaluate(
            &self.rules,
            "guest",
            &[Line {
                product_id: p.id,
                sku: p.sku.clone(),
                category_id: Some(p.category_id),
                price,
                quantity: 1,
            }],
            None,
        );
        if assessed.amount > Decimal::ZERO {
            p.original_price = Some(p.price.clone());
        }
        p.price = format!("{:.2}", price - assessed.amount);
        p.offer_eligible = true;
        Ok(())
    }
}
fn product(s: &Snapshot, p: &Product, url: &str) -> Value {
    let mut v = json!({"@type":"Product","@id":format!("{url}#product"),"url":url,"name":p.name,"description":p.description});
    if !p.sku.trim().is_empty() {
        v["sku"] = json!(p.sku);
    }
    let specs: Vec<_> = p
        .attributes
        .as_object()
        .into_iter()
        .flat_map(|a| a.iter())
        .map(|(name, value)| json!({"@type":"PropertyValue","name":name,"value":value}))
        .collect();
    if !specs.is_empty() {
        v["additionalProperty"] = json!(specs);
    }
    if let Some(image) = p.image_id.and_then(|id| s.images.get(&id)) {
        v["image"] = json!({"@type":"ImageObject","contentUrl":format!("{}api/v1/catalog/media/{}/content",s.origin,image.id),"width":image.width,"height":image.height,"caption":if image.alt.trim().is_empty(){&p.name}else{&image.alt}});
    }
    if p.offer_eligible {
        v["offers"] = json!({"@type":"Offer","url":url,"price":p.price,"priceCurrency":p.currency,"seller":{"@id":format!("{}#merchant",s.origin)}});
    }
    v
}
pub fn structured_data(s: &Snapshot) -> Option<Value> {
    let canonical = s.canonical.as_ref()?;
    if s.status != 200 {
        return None;
    }
    let mut graph = vec![
        json!({"@type":"Organization","@id":format!("{}#merchant",s.origin),"name":s.site_name,"url":s.origin}),
        json!({"@type":"WebSite","@id":format!("{}#website",s.origin),"url":s.origin,"name":s.site_name,"inLanguage":s.locale,"publisher":{"@id":format!("{}#merchant",s.origin)}}),
    ];
    if let Some(m) = &s.merchant {
        let organization = &mut graph[0];
        if !m.legal_name.is_empty() {
            organization["legalName"] = json!(m.legal_name);
        }
        if !m.description.is_empty() {
            organization["description"] = json!(m.description);
        }
        if !m.email.is_empty() || !m.telephone.is_empty() {
            let mut contact = json!({"@type":"ContactPoint","contactType":"customer service"});
            if !m.email.is_empty() {
                contact["email"] = json!(m.email);
            }
            if !m.telephone.is_empty() {
                contact["telephone"] = json!(m.telephone);
            }
            organization["contactPoint"] = contact;
        }
        if !m.social_profiles.is_empty() {
            organization["sameAs"] = json!(m.social_profiles);
        }
        if !m.delivery_areas.is_empty() {
            organization["areaServed"] = json!(m.delivery_areas);
        }
        if !m.locations.is_empty() {
            organization["location"] = json!(m.locations);
        }
        if let Some(image) = m.logo_id.and_then(|id| s.images.get(&id)) {
            organization["logo"] = json!({"@type":"ImageObject","contentUrl":format!("{}api/v1/catalog/media/{}/content",s.origin,image.id),"width":image.width,"height":image.height});
        }
    }
    if let Some(p) = &s.product {
        let mut value = product(s, p, &canonical.json_ld);
        if p.product_type == "configurable" {
            value["@type"] = json!("ProductGroup");
            value["productGroupID"] = json!(p.id.to_string());
            if !s.variant_dimensions.is_empty() {
                value["variesBy"] = json!(s.variant_dimensions);
            }
            if !s.family.is_empty() {
                value["hasVariant"] = json!(s
                    .family
                    .iter()
                    .filter_map(|p| s.related_canonicals.get(&p.id).map(|identity| product(
                        s,
                        p,
                        &identity.json_ld
                    )))
                    .collect::<Vec<_>>());
            }
        }
        if let Some(parent) = &s.parent_product {
            if parent.product_type == "configurable"
                && s.related_canonicals.contains_key(&parent.id)
            {
                value["isVariantOf"] = json!({"@type":"ProductGroup","@id":format!("{}#product",s.related_canonicals[&parent.id].json_ld),"url":s.related_canonicals[&parent.id].json_ld,"name":parent.name,"productGroupID":parent.id.to_string()});
            }
        }
        graph.push(value);
    }
    if s.kind != "home" {
        let mut crumbs =
            vec![json!({"@type":"ListItem","position":1,"name":s.site_name,"item":s.origin})];
        let mut chain = vec![];
        let mut id = s.category_id;
        let mut seen = std::collections::HashSet::new();
        while let Some(category) = s.categories.iter().find(|c| Some(c.id) == id) {
            if !seen.insert(category.id) {
                break;
            }
            chain.push(category);
            id = category.parent_id;
        }
        for category in chain.into_iter().rev() {
            crumbs.push(json!({"@type":"ListItem","position":crumbs.len()+1,"name":category.name,"item":format!("{}categories/{}",s.origin,category.slug)}));
        }
        let name = s
            .product
            .as_ref()
            .map(|p| p.name.as_str())
            .or_else(|| s.content.as_ref().map(|c| c.title.as_str()));
        if let Some(name) = name {
            crumbs.push(json!({"@type":"ListItem","position":crumbs.len()+1,"name":name,"item":canonical.json_ld}));
        }
        graph.push(json!({"@type":"BreadcrumbList","itemListElement":crumbs}));
    }
    let name = s
        .product
        .as_ref()
        .map(|p| p.name.as_str())
        .or_else(|| {
            s.categories
                .iter()
                .find(|c| Some(c.id) == s.category_id)
                .map(|c| c.name.as_str())
        })
        .or_else(|| {
            s.content
                .as_ref()
                .filter(|_| s.kind == "content")
                .map(|c| c.title.as_str())
        })
        .unwrap_or(&s.site_name);
    let mut page = json!({"@type":"WebPage","@id":format!("{}#webpage",canonical.json_ld),"url":canonical.json_ld,"name":name,"inLanguage":s.locale,"isPartOf":{"@id":format!("{}#website",s.origin)}});
    if s.product.is_some() {
        page["mainEntity"] = json!({"@id":format!("{}#product",canonical.json_ld)});
    }
    if let Some(content) = &s.content {
        page["dateModified"] = json!(content.updated_at.to_rfc3339());
        page["publisher"] = json!({"@id":format!("{}#merchant",s.origin)});
    }
    graph.push(page);
    Some(json!({"@context":"https://schema.org","@graph":graph}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(currency: &str) -> Product {
        Product {
            sku: "SKU".into(),
            parent_id: None,
            offer_eligible: false,
            price_diagnostic: String::new(),
            id: uuid::Uuid::nil(),
            entity_id: 1,
            slug: "item".into(),
            name: "Item".into(),
            description: "Description".into(),
            price: "12.30".into(),
            original_price: None,
            product_type: "simple".into(),
            currency: currency.into(),
            unit: "each".into(),
            category_id: uuid::Uuid::nil(),
            image_id: None,
            image_alt: None,
            attributes: json!({}),
        }
    }
    #[test]
    fn unsupported_currency_is_preserved_but_never_offered_or_converted() {
        let pricing = Pricing {
            rules: vec![],
            ambiguous: false,
        };
        for currency in ["EUR", "EGP", "JPY", ""] {
            let mut p = item(currency);
            pricing.apply(&mut p).unwrap();
            assert_eq!(p.currency, currency);
            assert_eq!(p.price, "12.30");
            assert!(!p.offer_eligible);
            assert_eq!(p.price_diagnostic, "unsupported_checkout_currency");
        }
    }
    #[test]
    fn conditional_price_and_composite_price_do_not_become_offers() {
        let mut p = item("USD");
        Pricing {
            rules: vec![],
            ambiguous: true,
        }
        .apply(&mut p)
        .unwrap();
        assert!(!p.offer_eligible);
        for kind in ["configurable", "grouped", "bundle"] {
            p.product_type = kind.into();
            Pricing {
                rules: vec![],
                ambiguous: false,
            }
            .apply(&mut p)
            .unwrap();
            assert!(!p.offer_eligible);
        }
    }
}
