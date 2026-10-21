//! Composite listings resolve to real simple SKUs; no synthetic stock or price is sold.
use super::*;
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Link {
    pub child_id: Uuid,
    pub option_label: String,
    pub quantity: i32,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Structure {
    pub product_type: String,
    pub configurable_attributes: Vec<String>,
    pub children: Vec<Link>,
}
#[derive(Serialize)]
pub struct ProductFamily {
    pub structure: Structure,
    pub children: Vec<Product>,
}
impl Service {
    pub async fn family(&self, id: Uuid) -> Result<ProductFamily> {
        let p = self.product(id).await?;
        let attrs=sqlx::query_scalar("SELECT configurable_attributes FROM catalog.product_configurations WHERE parent_product_id=$1").bind(id).fetch_optional(&self.pool).await?.unwrap_or_default();
        let rows:Vec<(Uuid,String,i32)>=sqlx::query_as("SELECT child_id,option_label,quantity FROM catalog.product_links WHERE parent_id=$1 ORDER BY position").bind(id).fetch_all(&self.pool).await?;
        let children=sqlx::query_as("SELECT p.* FROM catalog.products p JOIN catalog.product_links l ON l.child_id=p.id WHERE l.parent_id=$1 ORDER BY l.position").bind(id).fetch_all(&self.pool).await?;
        Ok(ProductFamily {
            structure: Structure {
                product_type: p.product_type,
                configurable_attributes: attrs,
                children: rows
                    .into_iter()
                    .map(|(child_id, option_label, quantity)| Link {
                        child_id,
                        option_label,
                        quantity,
                    })
                    .collect(),
            },
            children,
        })
    }
    pub async fn structure(&self, id: Uuid, i: Structure) -> Result<ProductFamily> {
        if !["simple", "configurable", "grouped", "bundle"].contains(&i.product_type.as_str())
            || i.children.len() > 100
            || (i.product_type == "simple"
                && (!i.children.is_empty() || !i.configurable_attributes.is_empty()))
            || (i.product_type != "simple" && i.children.is_empty())
            || (i.product_type != "configurable" && !i.configurable_attributes.is_empty())
        {
            return Err(invalid(
                "Choose a product type and its children (at most 100)",
            ));
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(3003)")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        let parent: Product = sqlx::query_as("SELECT * FROM catalog.products WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
        if parent.parent_id.is_some() {
            return Err(invalid("Detach this variant from its parent first"));
        }
        if parent.product_type != i.product_type {
            let used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inventory.reservations WHERE product_id=$1) OR EXISTS(SELECT 1 FROM catalog.product_links WHERE child_id=$1)").bind(id).fetch_one(&mut *tx).await?;
            if used {
                return Err(invalid("A reserved or linked SKU cannot change type"));
            }
        }
        let defs = domain_attributes::definitions(&mut tx, "product").await?;
        if i.product_type == "configurable"
            && (i.configurable_attributes.is_empty()
                || i.configurable_attributes.len() > 3
                || i.configurable_attributes.iter().enumerate().any(|(n, c)| {
                    i.configurable_attributes[..n].contains(c)
                        || !defs.iter().any(|d| {
                            d.metadata.active()
                                && d.attribute_code == *c
                                && d.used_for_configurations
                                && domain_attributes::metadata::canonical_type(&d.input_type)
                                    == "select"
                        })
                }))
        {
            return Err(invalid(
                "Choose 1–3 unique select attributes enabled for configurations",
            ));
        }
        let old: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM catalog.products WHERE parent_id=$1")
                .bind(id)
                .fetch_all(&mut *tx)
                .await?;
        let mut tuples = std::collections::HashSet::new();
        let mut seen = std::collections::HashSet::new();
        for link in &i.children {
            if link.child_id == id
                || !seen.insert(link.child_id)
                || !(1..=999).contains(&link.quantity)
                || link.option_label.len() > 120
                || (i.product_type == "bundle" && link.option_label.trim().is_empty())
            {
                return Err(invalid("Children must be distinct; bundle choices need a group label and valid quantity"));
            }
            let child: Product = sqlx::query_as("SELECT * FROM catalog.products WHERE id=$1")
                .bind(link.child_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(Error::NotFound)?;
            if child.product_type != "simple"
                || child.parent_id.is_some_and(|p| p != id)
                || child.currency != parent.currency
            {
                return Err(invalid("Children must be simple SKUs in the same currency, without another configurable parent"));
            }
            if i.product_type == "configurable" {
                let mut tuple = serde_json::Map::new();
                for code in &i.configurable_attributes {
                    let value = child.attributes.get(code).ok_or_else(|| {
                        invalid("Set each child's option attributes before attaching it")
                    })?;
                    tuple.insert(code.clone(), value.clone());
                }
                if !tuples.insert(Value::Object(tuple.clone()).to_string()) {
                    return Err(invalid(
                        "Two variants cannot have the same option combination",
                    ));
                }
            }
        }
        sqlx::query(
            "UPDATE catalog.products SET parent_id=NULL,variant_attributes='{}' WHERE parent_id=$1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM catalog.product_links WHERE parent_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM catalog.product_configurations WHERE parent_product_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if i.product_type == "configurable" {
            sqlx::query("INSERT INTO catalog.product_configurations(id,parent_product_id,configurable_attributes) VALUES($1,$2,$3)").bind(Uuid::new_v4()).bind(id).bind(&i.configurable_attributes).execute(&mut *tx).await?;
        }
        for (position, link) in i.children.iter().enumerate() {
            sqlx::query("INSERT INTO catalog.product_links(parent_id,child_id,position,option_label,quantity) VALUES($1,$2,$3,$4,$5)").bind(id).bind(link.child_id).bind(position as i32).bind(&link.option_label).bind(link.quantity).execute(&mut *tx).await?;
            if i.product_type == "configurable" {
                sqlx::query("UPDATE catalog.products SET parent_id=$2,variant_attributes=(SELECT jsonb_object_agg(key,value) FROM jsonb_each(attributes) WHERE key=ANY($3)) WHERE id=$1").bind(link.child_id).bind(id).bind(&i.configurable_attributes).execute(&mut *tx).await?;
            }
            Self::changed(&mut tx, "catalog.product_updated", link.child_id).await?;
        }
        sqlx::query(
            "UPDATE catalog.products SET product_type=$2,updated_at=clock_timestamp() WHERE id=$1",
        )
        .bind(id)
        .bind(&i.product_type)
        .execute(&mut *tx)
        .await?;
        for child in old {
            Self::changed(&mut tx, "catalog.product_updated", child).await?;
        }
        Self::changed(&mut tx, "catalog.product_updated", id).await?;
        tx.commit().await?;
        self.family(id).await
    }
    pub async fn category_values(&self, id: Uuid, value: Value) -> Result<Value> {
        let mut tx = self.transaction().await?;
        domain_attributes::validate(&mut tx, "category", id, &value, false).await?;
        if sqlx::query("UPDATE catalog.categories SET attributes=$2 WHERE id=$1")
            .bind(id)
            .bind(&value)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            == 0
        {
            return Err(Error::NotFound);
        }
        Self::changed(&mut tx, "catalog.category_updated", id).await?;
        tx.commit().await?;
        Ok(value)
    }
    pub async fn category_attributes(&self, id: Uuid) -> Result<Value> {
        sqlx::query_scalar("SELECT attributes FROM catalog.categories WHERE id=$1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(Error::NotFound)
    }
}
