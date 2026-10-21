//! Typed JSONB metadata; all value/definition writes share advisory lock 2002.
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;
pub mod enrichment;
pub mod industry;
pub mod metadata;
pub mod schema;
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub id: Uuid,
    // Writes always return the database identity; templates and create inputs omit it.
    #[serde(default, skip_serializing_if = "missing_entity_id")]
    pub entity_id: i64,
    pub entity_type: String,
    pub attribute_code: String,
    pub label: String,
    pub input_type: String,
    pub scope: String,
    pub is_required: bool,
    pub is_unique: bool,
    pub is_searchable: bool,
    pub is_filterable: bool,
    pub is_comparable: bool,
    pub is_visible_on_front: bool,
    pub used_for_promo_rules: bool,
    pub used_for_configurations: bool,
    pub swatch_type: String,
    pub options: Value,
    pub version: i32,
    #[serde(default)]
    pub metadata: sqlx::types::Json<metadata::Metadata>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetMember {
    pub definition_id: Uuid,
    pub group_name: String,
    pub position: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttributeSet {
    pub id: Uuid,
    // Writes always return the database identity; templates and create inputs omit it.
    #[serde(default, skip_serializing_if = "missing_entity_id")]
    pub entity_id: i64,
    pub name: String,
    pub description: String,
    pub version: i32,
    pub members: Vec<SetMember>,
}
fn missing_entity_id(value: &i64) -> bool {
    *value == 0
}
fn bad(s: &str) -> Error {
    Error::Invalid(s.into())
}
pub fn table(entity: &str) -> Result<&'static str> {
    match entity {
        "product" => Ok("catalog.products"),
        "customer" => Ok("customers.customers"),
        "category" => Ok("catalog.categories"),
        _ => Err(bad("Invalid attribute entity")),
    }
}
pub async fn definitions(
    tx: &mut Transaction<'_, Postgres>,
    entity: &str,
) -> Result<Vec<Definition>> {
    table(entity)?;
    Ok(sqlx::query_as(
        "SELECT * FROM attributes.definitions WHERE entity_type=$1 ORDER BY label,id",
    )
    .bind(entity)
    .fetch_all(&mut **tx)
    .await?)
}
pub fn validate_definition(d: &Definition) -> Result<()> {
    table(&d.entity_type)?;
    if d.attribute_code.is_empty()
        || d.attribute_code.len() > 64
        || !d.attribute_code.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase() || (i > 0 && (b.is_ascii_digit() || b == b'_' || b == b'-'))
        })
        || d.label.trim().is_empty()
        || d.label.len() > 120
        || d.scope != "global"
        || ![
            "text",
            "textarea",
            "boolean",
            "select",
            "multiselect",
            "price",
            "date",
            "media_image",
            "integer",
            "decimal",
            "datetime",
            "measurement",
            "long_text",
            "single_select",
            "multi_select",
        ]
        .contains(&d.input_type.as_str())
        || !["none", "text", "color"].contains(&d.swatch_type.as_str())
    {
        return Err(bad("Invalid attribute definition"));
    }
    d.metadata.validate(d)?;
    let options = d
        .options
        .as_array()
        .ok_or_else(|| bad("Options must be a list"))?;
    if options.len() > 100
        || options.iter().enumerate().any(|(i, o)| {
            o["value"]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 100)
                || o["label"]
                    .as_str()
                    .is_none_or(|s| s.trim().is_empty() || s.len() > 120)
                || options[..i].iter().any(|p| p["value"] == o["value"])
                || o.get("labels").is_some_and(|v| {
                    v.as_object().is_none_or(|labels| {
                        labels.len() > 20
                            || labels.iter().any(|(locale, label)| {
                                locale.is_empty()
                                    || locale.len() > 20
                                    || label.as_str().is_none_or(|s| s.len() > 120)
                            })
                    })
                })
        })
    {
        return Err(bad("Options need unique values and labels (up to 100)"));
    }
    let choice = ["select", "multiselect"].contains(&metadata::canonical_type(&d.input_type));
    if choice == options.is_empty()
        || (!choice && d.swatch_type != "none")
        || (d.used_for_configurations
            && (d.entity_type != "product" || metadata::canonical_type(&d.input_type) != "select"))
        || ((d.is_filterable || d.is_searchable || d.used_for_promo_rules || d.is_visible_on_front)
            && d.entity_type == "customer")
    {
        return Err(bad("Invalid options or flags for this entity/input type"));
    }
    Ok(())
}

pub fn validate_value(d: &Definition, v: &Value) -> Result<()> {
    let values: Vec<&str> = d
        .options
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|o| o["value"].as_str())
        .collect();
    let valid = match metadata::canonical_type(&d.input_type) {
        "text" | "textarea" => v
            .as_str()
            .is_some_and(|s| s.len() <= 4000 && (!d.is_required || !s.trim().is_empty())),
        "integer" => v.as_i64().is_some(),
        "decimal" | "measurement" => v.as_f64().is_some_and(|n| n.is_finite()),
        "datetime" => v
            .as_str()
            .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok()),
        "boolean" => v.is_boolean(),
        "select" => v.as_str().is_some_and(|s| values.contains(&s)),
        "multiselect" => v.as_array().is_some_and(|a| {
            a.len() <= 100
                && (!d.is_required || !a.is_empty())
                && a.iter()
                    .all(|v| v.as_str().is_some_and(|s| values.contains(&s)))
                && a.iter().enumerate().all(|(i, v)| !a[..i].contains(v))
        }),
        "price" => v
            .as_str()
            .and_then(|s| s.parse::<rust_decimal::Decimal>().ok())
            .is_some_and(|n| {
                n.scale() <= 2
                    && !n.is_sign_negative()
                    && n <= rust_decimal::Decimal::from(9999999999u64)
            }),
        "date" => v.as_str().is_some_and(|s| {
            s.len() == 10 && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
        }),
        "media_image" => v.as_str().is_some_and(|s| Uuid::parse_str(s).is_ok()),
        _ => false,
    };
    let numeric = v.as_f64().or_else(|| {
        if d.input_type == "price" {
            v.as_str()?.parse().ok()
        } else {
            None
        }
    });
    let rules_valid = !numeric.is_some_and(|n| {
        d.metadata.min.is_some_and(|lo| n < lo) || d.metadata.max.is_some_and(|hi| n > hi)
    }) && !v.as_str().is_some_and(|text| {
        d.metadata
            .max_length
            .is_some_and(|n| text.chars().count() > n)
    });
    if valid && rules_valid {
        Ok(())
    } else {
        Err(bad(&format!("Invalid value for {}", d.label)))
    }
}
pub async fn validate(
    tx: &mut Transaction<'_, Postgres>,
    entity: &str,
    id: Uuid,
    value: &Value,
    allow_legacy: bool,
) -> Result<()> {
    validate_scoped(tx, entity, id, value, allow_legacy, None).await
}
pub async fn validate_product(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    value: &Value,
    set: Option<Uuid>,
) -> Result<()> {
    validate_scoped(tx, "product", id, value, true, set).await
}
async fn validate_scoped(
    tx: &mut Transaction<'_, Postgres>,
    entity: &str,
    id: Uuid,
    value: &Value,
    allow_legacy: bool,
    set: Option<Uuid>,
) -> Result<()> {
    let table = table(entity)?;
    let object = value
        .as_object()
        .ok_or_else(|| bad("Attributes must be an object"))?;
    if object.len() > 100 {
        return Err(bad("At most 100 attributes are allowed"));
    }
    let defs = definitions(tx, entity).await?;
    for key in object.keys() {
        if !defs.iter().any(|d| d.attribute_code == *key) && !allow_legacy {
            return Err(bad("Unknown attribute code"));
        }
    }
    let members: Vec<Uuid> = if let Some(set) = set {
        sqlx::query_scalar("SELECT definition_id FROM attributes.set_members WHERE set_id=$1")
            .bind(set)
            .fetch_all(&mut **tx)
            .await?
    } else {
        Vec::new()
    };
    for d in defs {
        if !d.metadata.active() {
            let previous: Option<Value> =
                sqlx::query_scalar(&format!("SELECT attributes->$2 FROM {table} WHERE id=$1"))
                    .bind(id)
                    .bind(&d.attribute_code)
                    .fetch_optional(&mut **tx)
                    .await?
                    .flatten();
            if object.get(&d.attribute_code) != previous.as_ref() {
                return Err(bad("Disabled attribute values cannot change"));
            }
            continue;
        }
        if let Some(v) = object.get(&d.attribute_code) {
            validate_value(&d, v)?;
            if d.input_type == "media_image" {
                let exists: bool =
                    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.media WHERE id=$1)")
                        .bind(Uuid::parse_str(v.as_str().unwrap()).unwrap())
                        .fetch_one(&mut **tx)
                        .await?;
                if !exists {
                    return Err(bad("Attribute image does not exist"));
                }
            }
            if d.is_unique {
                let used: bool = sqlx::query_scalar(&format!(
                    "SELECT EXISTS(SELECT 1 FROM {table} WHERE id<>$1 AND attributes->$2=$3)"
                ))
                .bind(id)
                .bind(&d.attribute_code)
                .bind(v)
                .fetch_one(&mut **tx)
                .await?;
                if used {
                    return Err(bad(&format!("{} must be unique", d.label)));
                }
            }
        } else if d.is_required && (set.is_none() || members.contains(&d.id)) {
            return Err(bad(&format!("{} is required", d.label)));
        }
    }
    Ok(())
}
pub async fn validate_set(
    tx: &mut Transaction<'_, Postgres>,
    set_id: Option<Uuid>,
    value: &Value,
) -> Result<()> {
    let Some(set_id) = set_id else {
        return Ok(());
    };
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attributes.sets WHERE id=$1)")
            .bind(set_id)
            .fetch_one(&mut **tx)
            .await?;
    if !exists {
        return Err(bad("Attribute set does not exist"));
    }
    let allowed: Vec<String> = sqlx::query_scalar(
        "SELECT d.attribute_code FROM attributes.set_members m JOIN attributes.definitions d ON d.id=m.definition_id WHERE m.set_id=$1",
    ).bind(set_id).fetch_all(&mut **tx).await?;
    let product_codes: Vec<String> = sqlx::query_scalar(
        "SELECT attribute_code FROM attributes.definitions WHERE entity_type='product'",
    )
    .fetch_all(&mut **tx)
    .await?;
    if value.as_object().is_some_and(|values| {
        product_codes
            .iter()
            .any(|code| values.contains_key(code) && !allowed.contains(code))
    }) {
        return Err(bad(
            "Product contains an attribute outside its attribute set",
        ));
    }
    Ok(())
}
impl Service {
    pub async fn sets(&self) -> Result<Vec<AttributeSet>> {
        let rows: Vec<(Uuid, i64, String, String, i32)> = sqlx::query_as(
            "SELECT id,entity_id,name,description,version FROM attributes.sets ORDER BY name,id",
        )
        .fetch_all(&self.pool)
        .await?;
        let all_members: Vec<(Uuid,Uuid,String,i32)> = sqlx::query_as("SELECT set_id,definition_id,group_name,position FROM attributes.set_members ORDER BY group_name,position,definition_id").fetch_all(&self.pool).await?;
        let mut result = Vec::with_capacity(rows.len());
        for (id, entity_id, name, description, version) in rows {
            let members: Vec<(Uuid, String, i32)> = all_members
                .iter()
                .filter(|m| m.0 == id)
                .map(|m| (m.1, m.2.clone(), m.3))
                .collect();
            result.push(AttributeSet {
                id,
                entity_id,
                name,
                description,
                version,
                members: members
                    .into_iter()
                    .map(|(definition_id, group_name, position)| SetMember {
                        definition_id,
                        group_name,
                        position,
                    })
                    .collect(),
            });
        }
        Ok(result)
    }
    pub async fn save_set(&self, set: AttributeSet) -> Result<AttributeSet> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let result = Self::save_set_in(&mut tx, set).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub(crate) async fn save_set_in(
        tx: &mut Transaction<'_, Postgres>,
        mut set: AttributeSet,
    ) -> Result<AttributeSet> {
        if set.name.trim().is_empty() || set.name.len() > 120 || set.description.len() > 500 {
            return Err(bad("Invalid attribute set name or description"));
        }
        let mut seen = std::collections::HashSet::new();
        if set.members.len() > 100
            || set.members.iter().any(|m| {
                m.group_name.trim().is_empty()
                    || m.group_name.len() > 80
                    || m.position < 0
                    || !seen.insert(m.definition_id)
            })
        {
            return Err(bad(
                "Attribute set members need a group, position and unique attribute",
            ));
        }
        let old: Option<i32> =
            sqlx::query_scalar("SELECT version FROM attributes.sets WHERE id=$1")
                .bind(set.id)
                .fetch_optional(&mut **tx)
                .await?;
        if let Some(version) = old {
            if set.version != version {
                return Err(Error::Conflict);
            }
            set.version += 1;
        } else {
            if set.version != 0 {
                return Err(Error::Conflict);
            }
            set.version = 1;
        }
        if !set.members.is_empty() {
            let ids: Vec<Uuid> = set.members.iter().map(|m| m.definition_id).collect();
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM attributes.definitions WHERE entity_type='product' AND id=ANY($1)")
                .bind(&ids).fetch_one(&mut **tx).await?;
            if count != ids.len() as i64 {
                return Err(bad("Attribute sets can contain product attributes only"));
            }
        }
        let ids: Vec<Uuid> = set.members.iter().map(|m| m.definition_id).collect();
        let strands: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.products p JOIN attributes.definitions d ON d.entity_type='product' AND p.attributes ? d.attribute_code WHERE p.attribute_set_id=$1 AND NOT(d.id=ANY($2)))").bind(set.id).bind(&ids).fetch_one(&mut **tx).await?;
        if strands {
            return Err(bad(
                "Set changes cannot remove attributes used by assigned products",
            ));
        }
        let missing: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.products p JOIN attributes.definitions d ON d.id=ANY($2) AND d.is_required WHERE p.attribute_set_id=$1 AND NOT(p.attributes ? d.attribute_code))").bind(set.id).bind(&ids).fetch_one(&mut **tx).await?;
        if missing {
            return Err(bad("Assigned products are missing required set attributes"));
        }
        set.entity_id = sqlx::query_scalar("INSERT INTO attributes.sets(id,name,description,version) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$2,description=$3,version=$4,updated_at=clock_timestamp() RETURNING entity_id")
            .bind(set.id).bind(set.name.trim()).bind(set.description.trim()).bind(set.version).fetch_one(&mut **tx).await?;
        sqlx::query("DELETE FROM attributes.set_members WHERE set_id=$1")
            .bind(set.id)
            .execute(&mut **tx)
            .await?;
        for member in &set.members {
            sqlx::query("INSERT INTO attributes.set_members(set_id,definition_id,group_name,position) VALUES($1,$2,$3,$4)")
                .bind(set.id).bind(member.definition_id).bind(member.group_name.trim()).bind(member.position).execute(&mut **tx).await?;
        }
        infra_events::record(
            tx,
            "catalog.attribute_set_updated",
            json!({"id":set.id,"name":set.name}),
        )
        .await?;
        set.name = set.name.trim().into();
        set.description = set.description.trim().into();
        Ok(set)
    }
    pub async fn delete_set(&self, id: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let used: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.products WHERE attribute_set_id=$1) OR EXISTS(SELECT 1 FROM attributes.catalog_configuration WHERE default_attribute_set_id=$1)").bind(id).fetch_one(&mut *tx).await?;
        if used {
            return Err(bad(
                "Attribute set is in use; reassign products and catalog default before deleting",
            ));
        }
        let deleted = sqlx::query("DELETE FROM attributes.sets WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if deleted.rows_affected() == 0 {
            return Err(Error::NotFound);
        }
        infra_events::record(
            &mut tx,
            "catalog.attribute_set_updated",
            json!({"id":id,"deleted":true}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn list(&self, entity: &str) -> Result<Vec<Definition>> {
        let mut tx = self.pool.begin().await?;
        definitions(&mut tx, entity).await
    }
    pub async fn save(&self, d: Definition) -> Result<Definition> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let result = Self::save_in(&mut tx, d).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub(crate) async fn save_in(
        tx: &mut Transaction<'_, Postgres>,
        mut d: Definition,
    ) -> Result<Definition> {
        let table = table(&d.entity_type)?;
        validate_definition(&d)?;
        let old: Option<Definition> =
            sqlx::query_as("SELECT * FROM attributes.definitions WHERE id=$1")
                .bind(d.id)
                .fetch_optional(&mut **tx)
                .await?;
        if let Some(old) = old {
            if d.version != old.version {
                return Err(Error::Conflict);
            }
            if d.attribute_code != old.attribute_code
                || d.entity_type != old.entity_type
                || d.input_type != old.input_type
            {
                return Err(bad(
                    "An existing definition's entity, code and type cannot change",
                ));
            }
            let configured:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.product_configurations WHERE $1=ANY(configurable_attributes))").bind(&d.attribute_code).fetch_one(&mut **tx).await?;
            if d.entity_type == "product"
                && configured
                && (!d.used_for_configurations || !d.metadata.active())
            {
                return Err(bad(
                    "Detach product configurations before changing their options",
                ));
            }
            if old.metadata.source_policy == "trusted_only"
                && d.metadata.source_policy != "trusted_only"
            {
                return Err(bad("Trusted-only source policies cannot be weakened"));
            }
            let referenced:Vec<String>=sqlx::query_scalar("SELECT value_code FROM attributes.value_relationships WHERE definition_id=$1 UNION SELECT target_value_code FROM attributes.value_relationships WHERE target_definition_id=$1").bind(d.id).fetch_all(&mut **tx).await?;
            if referenced.iter().any(|code| {
                !d.options
                    .as_array()
                    .is_some_and(|opts| opts.iter().any(|o| o["value"].as_str() == Some(code)))
            }) {
                return Err(bad("Options referenced by relationships cannot be removed"));
            }
            d.version += 1;
        } else {
            if d.version != 0 {
                return Err(Error::Conflict);
            }
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM attributes.definitions WHERE entity_type=$1",
            )
            .bind(&d.entity_type)
            .fetch_one(&mut **tx)
            .await?;
            if count >= 100 {
                return Err(bad("At most 100 definitions per entity"));
            }
            if d.entity_type == "product" {
                let legacy: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM catalog.attributes WHERE code=$1)",
                )
                .bind(&d.attribute_code)
                .fetch_one(&mut **tx)
                .await?;
                if legacy {
                    return Err(bad("This code belongs to a legacy attribute"));
                }
            }
            d.version = 1;
        }
        d.entity_id = sqlx::query_scalar("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,scope,is_required,is_unique,is_searchable,is_filterable,is_comparable,is_visible_on_front,used_for_promo_rules,used_for_configurations,swatch_type,options,version,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(id) DO UPDATE SET label=$4,is_required=$7,is_unique=$8,is_searchable=$9,is_filterable=$10,is_comparable=$11,is_visible_on_front=$12,used_for_promo_rules=$13,used_for_configurations=$14,swatch_type=$15,options=$16,version=$17,metadata=$18 RETURNING entity_id")
   .bind(d.id).bind(&d.entity_type).bind(&d.attribute_code).bind(&d.label).bind(&d.input_type).bind(&d.scope).bind(d.is_required).bind(d.is_unique).bind(d.is_searchable).bind(d.is_filterable).bind(d.is_comparable).bind(d.is_visible_on_front).bind(d.used_for_promo_rules).bind(d.used_for_configurations).bind(&d.swatch_type).bind(&d.options).bind(d.version).bind(&d.metadata).fetch_one(&mut **tx).await?;
        // Validate existing values without changing any entity rows, including required and unique flags.
        if d.is_required && d.metadata.active() {
            let missing: bool = sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM {table} p WHERE NOT(attributes ? $1) {})", if d.entity_type=="product" {"AND (attribute_set_id IS NULL OR EXISTS(SELECT 1 FROM attributes.set_members m WHERE m.set_id=p.attribute_set_id AND m.definition_id=$2))"} else {"AND $2::uuid IS NOT NULL"}))
                .bind(&d.attribute_code).bind(d.id).fetch_one(&mut **tx).await?;
            if missing {
                return Err(bad("Existing entities are missing this required attribute"));
            }
        }
        if d.is_unique {
            let duplicates: bool = sqlx::query_scalar(&format!("SELECT EXISTS(SELECT attributes->$1 FROM {table} WHERE attributes ? $1 GROUP BY attributes->$1 HAVING count(*)>1)"))
                .bind(&d.attribute_code).fetch_one(&mut **tx).await?;
            if duplicates {
                return Err(bad("Existing attribute values are not unique"));
            }
        }
        let mut after = Uuid::nil();
        loop {
            let rows: Vec<(Uuid,Value)> = sqlx::query_as(&format!("SELECT id,attributes->$1 FROM {table} WHERE id>$2 AND attributes ? $1 ORDER BY id LIMIT 200"))
                .bind(&d.attribute_code).bind(after).fetch_all(&mut **tx).await?;
            if rows.is_empty() {
                break;
            }
            for (id, value) in rows {
                validate_value(&d, &value)?;
                after = id;
            }
        }
        infra_events::record(
            tx,
            "catalog.attribute_definition_updated",
            json!({"id":d.id,"entity_type":d.entity_type,"attribute_code":d.attribute_code}),
        )
        .await?;
        Ok(d)
    }
    pub async fn delete(&self, id: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let d: Definition = sqlx::query_as("SELECT * FROM attributes.definitions WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
        let table = table(&d.entity_type)?;
        let used:bool=sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE attributes ? $1) OR EXISTS(SELECT 1 FROM catalog.product_configurations WHERE $1=ANY(configurable_attributes))")).bind(&d.attribute_code).fetch_one(&mut *tx).await?;
        if used {
            return Err(Error::Conflict);
        }
        sqlx::query("DELETE FROM attributes.definitions WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        infra_events::record(
            &mut tx,
            "catalog.attribute_definition_updated",
            json!({"id":id,"entity_type":d.entity_type,"attribute_code":d.attribute_code}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
}
