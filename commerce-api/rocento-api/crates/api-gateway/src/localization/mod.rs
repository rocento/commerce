//! Language configuration and translation preparation.
use crate::identity::{self, ApiError};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::HeaderMap,
    middleware,
    routing::get,
    Json, Router,
};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

mod interface;

type Result<T> = std::result::Result<T, ApiError>;

pub fn router(app: identity::App) -> Router {
    Router::new()
        .route("/v1/admin/languages", get(list).post(save_language))
        .route(
            "/v1/admin/languages/{locale}/translations",
            get(translations),
        )
        .route(
            "/v1/admin/languages/{locale}/translations/{kind}/{id}",
            get(translation).put(save_translation),
        )
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .merge(interface::router())
        .layer(middleware::from_fn_with_state(
            app.clone(),
            identity::policy,
        ))
        .layer(middleware::map_response(
            |mut response: axum::response::Response| async {
                response.headers_mut().insert(
                    "cache-control",
                    axum::http::HeaderValue::from_static("private, no-store"),
                );
                response
            },
        ))
        .with_state(app)
}

pub fn public_router(app: identity::App) -> Router {
    Router::new()
        .route("/v1/languages", get(public_languages))
        .merge(interface::public_router())
        .with_state(app)
}

async fn public_languages(State(a): State<identity::App>) -> Result<Json<Value>> {
    let source: String =
        sqlx::query_scalar("SELECT source_locale FROM cms.language_settings WHERE singleton")
            .fetch_one(&a.admins.pool)
            .await?;
    let languages: Vec<Language> = sqlx::query_as("SELECT locale,name,native_name,direction,revision FROM cms.storefront_languages ORDER BY name,locale")
        .fetch_all(&a.admins.pool)
        .await?;
    Ok(Json(json!({"source_locale":source,"languages":languages})))
}

#[derive(Serialize, FromRow)]
pub struct Language {
    pub locale: String,
    pub name: String,
    pub native_name: String,
    pub direction: String,
    pub revision: i32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LanguageInput {
    pub locale: String,
    pub name: String,
    pub native_name: String,
    pub direction: String,
    pub expected_revision: i32,
}

// Supported canonical BCP-47 subset: language[-Script][-REGION].
// Deliberately reject URL syntax and noncanonical aliases instead of creating duplicates.
fn valid_locale(value: &str) -> bool {
    let parts: Vec<_> = value.split('-').collect();
    let language = parts[0];
    if !(2..=3).contains(&language.len()) || !language.bytes().all(|b| b.is_ascii_lowercase()) {
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

async fn actor(a: &identity::App, h: &HeaderMap, permission: &str) -> Result<Uuid> {
    let who = a
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require(permission)?;
    Ok(who.user.id)
}

async fn list(State(a): State<identity::App>, h: HeaderMap) -> Result<Json<Value>> {
    actor(&a, &h, "languages.read").await?;
    let source: String =
        sqlx::query_scalar("SELECT source_locale FROM cms.language_settings WHERE singleton")
            .fetch_one(&a.admins.pool)
            .await?;
    let languages: Vec<Language> = sqlx::query_as("SELECT locale,name,native_name,direction,revision FROM cms.storefront_languages ORDER BY name,locale").fetch_all(&a.admins.pool).await?;
    Ok(Json(
        json!({"source_locale":source,"languages":languages,"publication_available":false}),
    ))
}

async fn save_language(
    State(a): State<identity::App>,
    h: HeaderMap,
    Json(mut input): Json<LanguageInput>,
) -> Result<Json<Language>> {
    let actor = actor(&a, &h, "languages.write").await?;
    input.name = input.name.trim().to_owned();
    input.native_name = input.native_name.trim().to_owned();
    if !valid_locale(&input.locale)
        || input.expected_revision < 0
        || input.name.is_empty()
        || input.name.chars().count() > 80
        || input.native_name.is_empty()
        || input.native_name.chars().count() > 80
        || !["ltr", "rtl"].contains(&input.direction.as_str())
    {
        return Err(Error::Invalid(
            "Enter a canonical locale (for example ar, en-GB or zh-Hant), names and text direction"
                .into(),
        )
        .into());
    }
    let mut tx = a.admins.pool.begin().await?;
    let source: String = sqlx::query_scalar(
        "SELECT source_locale FROM cms.language_settings WHERE singleton FOR SHARE",
    )
    .fetch_one(&mut *tx)
    .await?;
    if source == input.locale {
        return Err(Error::Invalid(
            "This is the source language. Edit its content in the existing catalog editors".into(),
        )
        .into());
    }
    let saved: Option<Language> = if input.expected_revision == 0 {
        sqlx::query_as("INSERT INTO cms.storefront_languages(locale,name,native_name,direction) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING locale,name,native_name,direction,revision")
            .bind(&input.locale).bind(&input.name).bind(&input.native_name).bind(&input.direction).fetch_optional(&mut *tx).await?
    } else {
        sqlx::query_as("UPDATE cms.storefront_languages SET name=$2,native_name=$3,direction=$4,revision=revision+1,updated_at=clock_timestamp() WHERE locale=$1 AND revision=$5 RETURNING locale,name,native_name,direction,revision")
            .bind(&input.locale).bind(&input.name).bind(&input.native_name).bind(&input.direction).bind(input.expected_revision).fetch_optional(&mut *tx).await?
    };
    let saved = saved.ok_or(Error::Conflict)?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(actor),
        "languages.saved",
        Uuid::nil(),
        json!({"locale":saved.locale,"revision":saved.revision}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(saved))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TranslationQuery {
    #[serde(default = "product_kind")]
    kind: String,
    #[serde(default)]
    q: String,
    #[serde(default)]
    offset: i64,
}
fn product_kind() -> String {
    "product".into()
}
#[derive(Serialize, FromRow)]
struct TranslationRow {
    entity_id: Uuid,
    name: String,
    source: Value,
    fields: Value,
    revision: i32,
    status: String,
}
async fn translations(
    State(a): State<identity::App>,
    h: HeaderMap,
    Path(locale): Path<String>,
    Query(q): Query<TranslationQuery>,
) -> Result<Json<Value>> {
    actor(&a, &h, "languages.read").await?;
    actor(&a, &h, content_permission(&q.kind, false)?).await?;
    if !["product", "category", "navigation", "attribute"].contains(&q.kind.as_str())
        || q.offset < 0
        || q.offset > 1000000
        || q.q.len() > 200
    {
        return Err(Error::Invalid("Invalid translation filters".into()).into());
    }
    let mut tx = a.admins.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cms.storefront_languages WHERE locale=$1)")
            .bind(&locale)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::NotFound.into());
    }
    let rows: Vec<TranslationRow> = sqlx::query_as("SELECT s.entity_id,s.name,s.source,coalesce(t.fields,CASE WHEN s.entity_type='attribute' THEN cms.attribute_legacy_translation_fields(s.entity_id,$1) ELSE '{}'::jsonb END) fields,coalesce(t.revision,0) revision,CASE WHEN t.entity_id IS NULL THEN 'missing' WHEN t.source<>s.source THEN 'needs_review' WHEN t.reviewed THEN 'reviewed' ELSE 'draft' END status FROM cms.translation_sources s LEFT JOIN cms.catalog_translations t ON t.entity_type=s.entity_type AND t.entity_id=s.entity_id AND t.locale=$1 WHERE s.entity_type=$2 AND strpos(lower(s.name),lower($3))>0 ORDER BY s.name,s.entity_id LIMIT 50 OFFSET $4")
        .bind(&locale).bind(&q.kind).bind(&q.q).bind(q.offset).fetch_all(&mut *tx).await?;
    let counts: (i64,i64,i64,i64,i64) = sqlx::query_as("SELECT count(*),count(*) FILTER(WHERE t.entity_id IS NULL),count(*) FILTER(WHERE t.source<>s.source),count(*) FILTER(WHERE t.source=s.source AND t.reviewed),count(*) FILTER(WHERE t.source=s.source AND NOT t.reviewed) FROM cms.translation_sources s LEFT JOIN cms.catalog_translations t ON t.entity_type=s.entity_type AND t.entity_id=s.entity_id AND t.locale=$1 WHERE s.entity_type=$2 AND strpos(lower(s.name),lower($3))>0")
        .bind(&locale).bind(&q.kind).bind(&q.q).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"items":rows,"total":counts.0,"missing":counts.1,"needs_review":counts.2,"reviewed":counts.3,"draft":counts.4,"offset":q.offset,"limit":50}),
    ))
}

fn content_permission(kind: &str, write: bool) -> std::result::Result<&'static str, Error> {
    match (kind, write) {
        ("product" | "category", false) => Ok("catalog.read"),
        ("product" | "category", true) => Ok("catalog.write"),
        ("attribute", false) => Ok("attributes.read"),
        ("attribute", true) => Ok("attributes.write"),
        ("navigation", false) => Ok("cms.read"),
        ("navigation", true) => Ok("cms.write"),
        _ => Err(Error::Invalid("Unsupported translation type".into())),
    }
}

async fn translation(
    State(a): State<identity::App>,
    h: HeaderMap,
    Path((locale, kind, id)): Path<(String, String, Uuid)>,
) -> Result<Json<TranslationRow>> {
    actor(&a, &h, "languages.read").await?;
    actor(&a, &h, content_permission(&kind, false)?).await?;
    let row: TranslationRow = sqlx::query_as("SELECT s.entity_id,s.name,s.source,coalesce(t.fields,CASE WHEN s.entity_type='attribute' THEN cms.attribute_legacy_translation_fields(s.entity_id,$1) ELSE '{}'::jsonb END) fields,coalesce(t.revision,0) revision,CASE WHEN t.entity_id IS NULL THEN 'missing' WHEN t.source<>s.source THEN 'needs_review' WHEN t.reviewed THEN 'reviewed' ELSE 'draft' END status FROM cms.translation_sources s JOIN cms.storefront_languages l ON l.locale=$1 LEFT JOIN cms.catalog_translations t ON t.entity_type=s.entity_type AND t.entity_id=s.entity_id AND t.locale=l.locale WHERE s.entity_type=$2 AND s.entity_id=$3")
        .bind(locale).bind(kind).bind(id).fetch_optional(&a.admins.pool).await?.ok_or(Error::NotFound)?;
    Ok(Json(row))
}

fn navigation_field_limit(key: &str) -> Option<usize> {
    if key == "title" {
        return Some(800);
    }
    let parts: Vec<_> = key.split('.').collect();
    let index = |v: &str, max: usize| {
        v.parse::<usize>()
            .is_ok_and(|n| n < max && n.to_string() == v)
    };
    match parts.as_slice() {
        ["item", i, "label"] if index(i, 30) => Some(400),
        ["item", i, "badge"] if index(i, 30) => Some(160),
        ["item", i, "link", j, "label" | "group"] if index(i, 30) && index(j, 40) => Some(400),
        ["item", i, "link", j, "description"] if index(i, 30) && index(j, 40) => Some(800),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranslationInput {
    pub expected_revision: i32,
    pub source: Value,
    pub fields: Value,
    pub reviewed: bool,
}
fn validate_fields(kind: &str, input: &TranslationInput) -> std::result::Result<(), Error> {
    content_permission(kind, true)?;
    let field_limit = |key: &str| -> Option<usize> {
        input.source.get(key).and_then(Value::as_str)?;
        match kind {
            "navigation" => navigation_field_limit(key),
            "product" | "category" if key == "name" => Some(1000),
            "product" if key == "description" => Some(40000),
            "product" | "category" if key.starts_with("attribute.") => Some(40000),
            "attribute" if key == "label" || key.starts_with("option.") => Some(1000),
            "attribute" if key == "description" => Some(8000),
            _ => None,
        }
    };
    let fields = input
        .fields
        .as_object()
        .ok_or_else(|| Error::Invalid("Translation fields must be an object".into()))?;
    if input.expected_revision < 0
        || fields.iter().any(|(key, value)| {
            let limit = field_limit(key);
            limit.is_none()
                || value
                    .as_str()
                    .is_none_or(|s| s.len() > limit.unwrap_or(0) || s.contains('\0'))
        })
    {
        return Err(Error::Invalid(
            "Only translatable text fields can be saved".into(),
        ));
    }
    let required: Vec<&str> = input
        .source
        .as_object()
        .map(|source| {
            source
                .keys()
                .filter(|key| field_limit(key).is_some())
                .map(String::as_str)
                .collect()
        })
        .unwrap_or_default();
    if input.reviewed
        && required.iter().any(|key| {
            input.source[*key]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
                && fields
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.trim().is_empty())
        })
    {
        return Err(Error::Invalid(
            "Translate every nonempty source field before marking this item reviewed".into(),
        ));
    }
    Ok(())
}
async fn save_translation(
    State(a): State<identity::App>,
    h: HeaderMap,
    Path((locale, kind, id)): Path<(String, String, Uuid)>,
    Json(input): Json<TranslationInput>,
) -> Result<Json<Value>> {
    let actor = actor(&a, &h, "languages.write").await?;
    self::actor(&a, &h, content_permission(&kind, true)?).await?;
    validate_fields(&kind, &input)?;
    let mut tx = a.admins.pool.begin().await?;
    let language: Option<String> =
        sqlx::query_scalar("SELECT locale FROM cms.storefront_languages WHERE locale=$1 FOR SHARE")
            .bind(&locale)
            .fetch_optional(&mut *tx)
            .await?;
    language.ok_or(Error::NotFound)?;
    if kind == "product" || kind == "category" {
        sqlx::query(
            "SELECT id FROM attributes.definitions WHERE entity_type=$1 ORDER BY id FOR SHARE",
        )
        .bind(&kind)
        .fetch_all(&mut *tx)
        .await?;
    }
    if kind == "product" {
        sqlx::query("SELECT id FROM catalog.attributes ORDER BY id FOR SHARE")
            .fetch_all(&mut *tx)
            .await?;
    }
    // Lock the source row while reviewing to prevent approval against concurrent edits.
    let query = if kind == "product" {
        "SELECT jsonb_build_object('name',name,'description',description) || cms.catalog_text_translation_source('product',attributes) FROM catalog.products WHERE id=$1 FOR SHARE"
    } else if kind == "category" {
        "SELECT jsonb_build_object('name',name) || cms.catalog_text_translation_source('category',attributes) FROM catalog.categories WHERE id=$1 FOR SHARE"
    } else if kind == "attribute" {
        "SELECT cms.attribute_translation_source(label,metadata,options) FROM attributes.definitions WHERE id=$1 AND entity_type IN ('product','category','customer') FOR SHARE"
    } else {
        "SELECT cms.navigation_translation_source(r.title,r.blocks,d.version) FROM cms.documents d JOIN cms.revisions r ON r.document_id=d.id AND r.version=d.version WHERE d.id=$1 AND d.kind='navigation' FOR SHARE OF d"
    };
    let source: Value = sqlx::query_scalar(query)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
    if source != input.source {
        return Err(Error::Conflict.into());
    }
    let revision: Option<i32> = if input.expected_revision == 0 {
        sqlx::query_scalar("INSERT INTO cms.catalog_translations(locale,entity_type,entity_id,source,fields,reviewed,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING revision")
            .bind(&locale).bind(&kind).bind(id).bind(&source).bind(&input.fields).bind(input.reviewed).bind(actor).fetch_optional(&mut *tx).await?
    } else {
        sqlx::query_scalar("UPDATE cms.catalog_translations SET source=$4,fields=$5,reviewed=$6,updated_by=$7,revision=revision+1,updated_at=clock_timestamp() WHERE locale=$1 AND entity_type=$2 AND entity_id=$3 AND revision=$8 RETURNING revision")
            .bind(&locale).bind(&kind).bind(id).bind(&source).bind(&input.fields).bind(input.reviewed).bind(actor).bind(input.expected_revision).fetch_optional(&mut *tx).await?
    };
    let revision = revision.ok_or(Error::Conflict)?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(actor),
        "languages.translation.saved",
        id,
        json!({"locale":locale,"kind":kind,"revision":revision,"reviewed":input.reviewed}),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"revision":revision,"status":if input.reviewed {"reviewed"} else {"draft"}}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locale_codes_are_canonical_and_safe() {
        for code in [
            "en",
            "ar",
            "ar-EG",
            "zh-Hant",
            "zh-Hant-TW",
            "es-419",
            "fil",
        ] {
            assert!(valid_locale(code), "{code}");
        }
        for code in [
            "",
            "AR",
            "ar-eg",
            "en_US",
            "../ar",
            "en/",
            "en--US",
            "en-US-x-test",
            "zh-hant",
            "en-ABCD",
            "en-1234",
        ] {
            assert!(!valid_locale(code), "{code}");
        }
    }
    #[test]
    fn translation_cannot_override_commerce_or_skip_required_review_fields() {
        let mut input = TranslationInput {
            expected_revision: 0,
            source: json!({"name":"Apple","description":"Fresh"}),
            fields: json!({"name":"تفاح"}),
            reviewed: false,
        };
        assert!(validate_fields("product", &input).is_ok());
        input.reviewed = true;
        assert!(validate_fields("product", &input).is_err());
        input.fields = json!({"name":"تفاح","description":"طازج"});
        assert!(validate_fields("product", &input).is_ok());
        input.fields["price"] = json!("0");
        assert!(validate_fields("product", &input).is_err());
        input.fields = json!({"name":12});
        assert!(validate_fields("category", &input).is_err());
    }
}
