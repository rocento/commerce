//! Storefront UI copy, with one validation path for CSV and individual edits.
use super::{actor, Result};
use crate::identity;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap},
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgConnection};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const CATALOG: &str = include_str!("../../../../interface-messages.json");
const MAX_CSV: usize = 256 * 1024;
const FORMS: [&str; 6] = ["zero", "one", "two", "few", "many", "other"];

pub(super) fn router() -> Router<identity::App> {
    Router::new()
        .route("/v1/admin/languages/interface", get(read).put(edit))
        .route("/v1/admin/languages/interface/export", get(export))
        .route("/v1/admin/languages/interface/preview", post(preview))
        .route("/v1/admin/languages/interface/import", put(import))
        .layer(DefaultBodyLimit::max(512 * 1024))
}

pub(super) fn public_router() -> Router<identity::App> {
    Router::new().route("/v1/languages/interface", get(public_read))
}

#[derive(Clone, Deserialize, Serialize)]
struct Message {
    key: String,
    group: String,
    #[serde(default)]
    plural: Option<String>,
    en: BTreeMap<String, String>,
    ar: BTreeMap<String, String>,
}
impl Message {
    fn forms(&self, locale: &str) -> Option<&BTreeMap<String, String>> {
        match locale {
            "en" => Some(&self.en),
            "ar" => Some(&self.ar),
            _ => None,
        }
    }
}
#[derive(Deserialize)]
struct Catalog {
    messages: Vec<Message>,
}
#[derive(Serialize, FromRow)]
struct Override {
    key: String,
    locale: String,
    form: String,
    text: String,
    source_text: String,
}
#[derive(Serialize)]
struct Bundle {
    revision: i32,
    catalog_version: String,
    messages: Vec<Message>,
    overrides: Vec<Override>,
}
impl Bundle {
    fn source(&self, key: &str, locale: &str, form: &str) -> Option<&str> {
        self.messages
            .iter()
            .find(|m| m.key == key)?
            .forms(locale)?
            .get(form)
            .map(String::as_str)
    }
    fn text(&self, key: &str, locale: &str, form: &str) -> Option<&str> {
        let source = self.source(key, locale, form)?;
        Some(
            self.overrides
                .iter()
                .find(|o| o.key == key && o.locale == locale && o.form == form)
                .map_or(source, |o| o.text.as_str()),
        )
    }
}
async fn load(conn: &mut PgConnection, write: bool) -> Result<Bundle> {
    let revision = sqlx::query_scalar(if write {
        "SELECT revision FROM cms.interface_translation_state WHERE singleton FOR UPDATE"
    } else {
        "SELECT revision FROM cms.interface_translation_state WHERE singleton FOR SHARE"
    })
    .fetch_one(&mut *conn)
    .await?;
    let overrides = sqlx::query_as("SELECT message_key AS key,locale,form,text,source_text FROM cms.interface_translations ORDER BY message_key,locale,form").fetch_all(&mut *conn).await?;
    Ok(Bundle {
        revision,
        catalog_version: infra_auth::digest(CATALOG),
        messages: serde_json::from_str::<Catalog>(CATALOG)
            .expect("validated bundled interface catalog")
            .messages,
        overrides,
    })
}
async fn read(State(a): State<identity::App>, h: HeaderMap) -> Result<Json<Bundle>> {
    actor(&a, &h, "languages.read").await?;
    let mut tx = a.admins.pool.begin().await?;
    let bundle = load(&mut tx, false).await?;
    tx.commit().await?;
    Ok(Json(bundle))
}

async fn public_read(State(a): State<identity::App>) -> Result<impl IntoResponse> {
    let mut tx = a.admins.pool.begin().await?;
    let mut bundle = load(&mut tx, false).await?;
    tx.commit().await?;
    // Source edits invalidate older translations until the merchant reviews
    // them. Public responses contain only interface text, never admin metadata.
    let sources: BTreeMap<_, _> = bundle
        .messages
        .iter()
        .flat_map(|m| {
            ["en", "ar"].into_iter().flat_map(move |locale| {
                m.forms(locale).into_iter().flat_map(move |forms| {
                    forms.iter().map(move |(form, text)| {
                        (
                            (m.key.clone(), locale.to_owned(), form.clone()),
                            text.clone(),
                        )
                    })
                })
            })
        })
        .collect();
    bundle.overrides.retain(|o| {
        sources.get(&(o.key.clone(), o.locale.clone(), o.form.clone())) == Some(&o.source_text)
    });
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(bundle)))
}

fn placeholders(text: &str) -> std::result::Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '}' {
            return Err("Unmatched closing brace".into());
        }
        if c != '{' {
            continue;
        }
        let mut name = String::new();
        let mut closed = false;
        for next in chars.by_ref() {
            if next == '}' {
                closed = true;
                break;
            }
            name.push(next);
        }
        if !closed
            || name.is_empty()
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            || name.as_bytes()[0].is_ascii_digit()
        {
            return Err("Use simple placeholders such as {name}; braces must match".into());
        }
        names.insert(name);
    }
    Ok(names)
}
fn validate_text(source: &str, text: &str) -> std::result::Result<(), String> {
    if text.trim().is_empty()
        || text.chars().count() > 4000
        || text
            .chars()
            .any(|c| c.is_control() && !['\n', '\r', '\t'].contains(&c))
    {
        return Err("Text must contain 1–4000 characters without control characters".into());
    }
    let required = placeholders(source)?;
    if placeholders(text)? != required {
        return Err(format!(
            "Keep exactly these placeholders: {}",
            if required.is_empty() {
                "none".into()
            } else {
                required
                    .iter()
                    .map(|p| format!("{{{p}}}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CsvInput {
    csv: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportInput {
    csv: String,
    expected_revision: i32,
    catalog_version: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditInput {
    key: String,
    locale: String,
    form: String,
    text: Option<String>,
    expected_revision: i32,
    catalog_version: String,
}
#[derive(Serialize)]
struct Issue {
    row: usize,
    field: String,
    message: String,
}
#[derive(Serialize)]
struct Change {
    key: String,
    locale: String,
    form: String,
    before: String,
    after: String,
}
#[derive(Serialize)]
struct Preview {
    revision: i32,
    catalog_version: String,
    changes: Vec<Change>,
    errors: Vec<Issue>,
}

fn dangerous_cell(s: &str) -> bool {
    s.starts_with(['\t', '\r', '\n']) || s.trim_start().starts_with(['=', '+', '-', '@'])
}
// Also escape existing apostrophes so exported text round-trips without ambiguity.
fn csv_escape(s: &str) -> String {
    if dangerous_cell(s) || s.starts_with('\'') {
        format!("'{s}")
    } else {
        s.into()
    }
}
fn csv_unescape(s: &str) -> &str {
    s.strip_prefix('\'')
        .filter(|rest| dangerous_cell(rest) || rest.starts_with('\''))
        .unwrap_or(s)
}
fn csv_quotes_valid(s: &str) -> bool {
    // Strict RFC-style quotes; the csv crate deliberately tolerates malformed quoting.
    let mut state = 0; // field start, unquoted, quoted, after closing quote
    for c in s.chars() {
        state = match (state, c) {
            (0, '"') => 2,
            (0, ',' | '\r' | '\n') => 0,
            (0, _) => 1,
            (1, '"') => return false,
            (1, ',' | '\r' | '\n') => 0,
            (1, _) => 1,
            (2, '"') => 3,
            (2, _) => 2,
            (3, '"') => 2,
            (3, ',' | '\r' | '\n') => 0,
            (3, _) => return false,
            _ => unreachable!(),
        };
    }
    state != 2
}
fn plan(bundle: &Bundle, content: &str) -> Preview {
    let mut result = Preview {
        revision: bundle.revision,
        catalog_version: bundle.catalog_version.clone(),
        changes: vec![],
        errors: vec![],
    };
    let issue = |row, field: &str, message: &str| Issue {
        row,
        field: field.into(),
        message: message.into(),
    };
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    if content.len() > MAX_CSV || !csv_quotes_valid(content) {
        result.errors.push(issue(
            1,
            "file",
            "Use valid UTF-8 CSV with matched quotes, at most 256 KiB",
        ));
        return result;
    }
    let mut reader = csv::ReaderBuilder::new().from_reader(content.as_bytes());
    let headers = match reader.headers() {
        Ok(v) => v.clone(),
        Err(_) => {
            result
                .errors
                .push(issue(1, "header", "Unable to read CSV header"));
            return result;
        }
    };
    let unique: BTreeSet<_> = headers.iter().collect();
    if headers.is_empty()
        || unique.len() != headers.len()
        || !unique.contains("key")
        || !unique.iter().any(|h| ["en", "ar"].contains(h))
        || unique
            .iter()
            .any(|h| !["key", "form", "en", "ar"].contains(h))
    {
        result.errors.push(issue(
            1,
            "header",
            "Use key, optional form, and en and/or ar columns, without duplicates",
        ));
        return result;
    }
    let key_col = headers.iter().position(|h| h == "key").unwrap();
    let form_col = headers.iter().position(|h| h == "form");
    let mut seen = BTreeSet::new();
    for (index, row) in reader.records().enumerate() {
        if index >= 1000 {
            result
                .errors
                .push(issue(index + 2, "file", "At most 1000 rows are allowed"));
            break;
        }
        if result.errors.len() >= 100 {
            break;
        }
        let record = match row {
            Ok(row) => row,
            Err(_) => {
                result.errors.push(issue(
                    index + 2,
                    "row",
                    "Malformed CSV row or incorrect column count",
                ));
                continue;
            }
        };
        let key = &record[key_col];
        let form = form_col
            .map(|i| &record[i])
            .filter(|v| !v.is_empty())
            .unwrap_or("other");
        let Some(message) = bundle.messages.iter().find(|m| m.key == key) else {
            result
                .errors
                .push(issue(index + 2, "key", "Unknown interface key"));
            continue;
        };
        if !seen.insert((key.to_owned(), form.to_owned())) {
            result
                .errors
                .push(issue(index + 2, "key", "Duplicate key and plural form"));
            continue;
        }
        if !FORMS.contains(&form) || (message.plural.is_none() && form != "other") {
            result
                .errors
                .push(issue(index + 2, "form", "Invalid plural form for this key"));
            continue;
        }
        for (i, locale) in headers
            .iter()
            .enumerate()
            .filter(|(_, v)| ["en", "ar"].contains(v))
        {
            let value = csv_unescape(&record[i]);
            if value.is_empty() {
                continue;
            } // Empty cells never erase existing translations.
            let Some(source) = bundle.source(key, locale, form) else {
                result.errors.push(issue(
                    index + 2,
                    locale,
                    "This plural form is not used by this language; leave the cell empty",
                ));
                continue;
            };
            if let Err(error) = validate_text(source, value) {
                result.errors.push(issue(index + 2, locale, &error));
                continue;
            }
            let before = bundle.text(key, locale, form).unwrap();
            if before != value
                || bundle.overrides.iter().any(|o| {
                    o.key == key && o.locale == locale && o.form == form && o.source_text != source
                })
            {
                result.changes.push(Change {
                    key: key.into(),
                    locale: locale.into(),
                    form: form.into(),
                    before: before.into(),
                    after: value.into(),
                });
            }
        }
    }
    result
}
async fn preview(
    State(a): State<identity::App>,
    h: HeaderMap,
    Json(input): Json<CsvInput>,
) -> Result<Json<Preview>> {
    actor(&a, &h, "languages.write").await?;
    let mut tx = a.admins.pool.begin().await?;
    let result = plan(&load(&mut tx, false).await?, &input.csv);
    tx.commit().await?;
    Ok(Json(result))
}
async fn store(
    conn: &mut PgConnection,
    bundle: &Bundle,
    change: &Change,
    actor: Uuid,
) -> Result<()> {
    sqlx::query("INSERT INTO cms.interface_translations(message_key,locale,form,text,source_text,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(message_key,locale,form) DO UPDATE SET text=excluded.text,source_text=excluded.source_text,updated_by=excluded.updated_by,updated_at=clock_timestamp()")
        .bind(&change.key).bind(&change.locale).bind(&change.form).bind(&change.after).bind(bundle.source(&change.key,&change.locale,&change.form).unwrap()).bind(actor).execute(conn).await?;
    Ok(())
}
async fn record(
    conn: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor: Uuid,
    action: &str,
    details: serde_json::Value,
) -> Result<i32> {
    let revision = sqlx::query_scalar("UPDATE cms.interface_translation_state SET revision=revision+1 WHERE singleton RETURNING revision").fetch_one(&mut **conn).await?;
    domain_admin_iam::Service::audit(conn, Some(actor), action, Uuid::nil(), details).await?;
    Ok(revision)
}
async fn import(
    State(a): State<identity::App>,
    h: HeaderMap,
    Json(input): Json<ImportInput>,
) -> Result<Json<serde_json::Value>> {
    let actor = actor(&a, &h, "languages.write").await?;
    let mut tx = a.admins.pool.begin().await?;
    let bundle = load(&mut tx, true).await?;
    if input.expected_revision != bundle.revision || input.catalog_version != bundle.catalog_version
    {
        return Err(Error::Conflict.into());
    }
    let preview = plan(&bundle, &input.csv);
    if !preview.errors.is_empty() {
        return Err(Error::Invalid(
            "CSV contains errors. Preview the file and resolve every error before importing".into(),
        )
        .into());
    }
    for change in &preview.changes {
        store(&mut tx, &bundle, change, actor).await?;
    }
    let count = preview.changes.len();
    let revision = if count > 0 {
        record(&mut tx,actor,"languages.interface.imported",json!({"changes":count,"keys":preview.changes.iter().map(|c| json!({"key":c.key,"locale":c.locale,"form":c.form})).collect::<Vec<_>>()})).await?
    } else {
        bundle.revision
    };
    tx.commit().await?;
    Ok(Json(json!({"revision":revision,"changed":count})))
}
async fn edit(
    State(a): State<identity::App>,
    h: HeaderMap,
    Json(input): Json<EditInput>,
) -> Result<Json<serde_json::Value>> {
    let actor = actor(&a, &h, "languages.write").await?;
    let mut tx = a.admins.pool.begin().await?;
    let bundle = load(&mut tx, true).await?;
    if input.expected_revision != bundle.revision || input.catalog_version != bundle.catalog_version
    {
        return Err(Error::Conflict.into());
    }
    let source = bundle
        .source(&input.key, &input.locale, &input.form)
        .ok_or_else(|| Error::Invalid("Unknown interface key, language or plural form".into()))?;
    if let Some(text) = &input.text {
        validate_text(source, text).map_err(Error::Invalid)?;
        store(
            &mut tx,
            &bundle,
            &Change {
                key: input.key.clone(),
                locale: input.locale.clone(),
                form: input.form.clone(),
                before: bundle
                    .text(&input.key, &input.locale, &input.form)
                    .unwrap()
                    .into(),
                after: text.clone(),
            },
            actor,
        )
        .await?;
    } else {
        sqlx::query(
            "DELETE FROM cms.interface_translations WHERE message_key=$1 AND locale=$2 AND form=$3",
        )
        .bind(&input.key)
        .bind(&input.locale)
        .bind(&input.form)
        .execute(&mut *tx)
        .await?;
    }
    let revision = record(&mut tx,actor,"languages.interface.edited",json!({"key":input.key,"locale":input.locale,"form":input.form,"reset":input.text.is_none()})).await?;
    tx.commit().await?;
    Ok(Json(json!({"revision":revision,"changed":1})))
}
fn csv_output(bundle: &Bundle) -> String {
    let mut writer = csv::Writer::from_writer(vec![]);
    writer.write_record(["key", "form", "en", "ar"]).unwrap();
    for message in &bundle.messages {
        for form in FORMS
            .iter()
            .filter(|f| message.en.contains_key(**f) || message.ar.contains_key(**f))
        {
            writer
                .write_record([
                    message.key.clone(),
                    (*form).into(),
                    csv_escape(bundle.text(&message.key, "en", form).unwrap_or("")),
                    csv_escape(bundle.text(&message.key, "ar", form).unwrap_or("")),
                ])
                .unwrap();
        }
    }
    format!(
        "\u{feff}{}",
        String::from_utf8(writer.into_inner().unwrap()).unwrap()
    )
}
async fn export(State(a): State<identity::App>, h: HeaderMap) -> Result<impl IntoResponse> {
    actor(&a, &h, "languages.read").await?;
    let mut tx = a.admins.pool.begin().await?;
    let output = csv_output(&load(&mut tx, false).await?);
    tx.commit().await?;
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=storefront-interface.csv",
            ),
        ],
        output,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bundle() -> Bundle {
        Bundle {
            revision: 1,
            catalog_version: "test".into(),
            messages: serde_json::from_str::<Catalog>(CATALOG).unwrap().messages,
            overrides: vec![],
        }
    }
    #[test]
    fn catalog_has_complete_plural_forms_and_safe_defaults() {
        let b = bundle();
        let mut keys = BTreeSet::new();
        for m in &b.messages {
            assert!(keys.insert(&m.key));
            for locale in ["en", "ar"] {
                let forms = m.forms(locale).unwrap();
                let expected: BTreeSet<_> = if m.plural.is_none() {
                    ["other"].into_iter().collect()
                } else if locale == "en" {
                    ["one", "other"].into_iter().collect()
                } else {
                    FORMS.into_iter().collect()
                };
                assert_eq!(
                    forms.keys().map(String::as_str).collect::<BTreeSet<_>>(),
                    expected
                );
                for text in forms.values() {
                    validate_text(text, text).unwrap();
                }
            }
        }
    }
    #[test]
    fn csv_round_trip_and_partial_updates() {
        let b = bundle();
        let p = plan(&b, &csv_output(&b));
        assert!(p.errors.is_empty());
        assert!(p.changes.is_empty());
        let p = plan(&b, "key,en,ar\ncart.add,Buy now,\n");
        assert!(p.errors.is_empty());
        assert_eq!(p.changes.len(), 1);
        let p = plan(&b, "key,form,en,ar\ncart.item_count,few,,{count} قطع\n");
        assert!(p.errors.is_empty());
        assert_eq!(p.changes.len(), 1);
        for csv in [
            "key,en,en\ncart.add,A,B",
            "key,en\nunknown,A",
            "key,en\ncart.add,A\ncart.add,B",
            "key,en\ncart.add,\"unfinished",
            "key,en\ncart.add,A,B",
            "key,en\ncart.add,hello {name}",
            "key,en\ncart.remove_item,Remove",
            "key,form,en\ncart.item_count,zero,None",
        ] {
            assert!(!plan(&b, csv).errors.is_empty(), "{csv}");
        }
    }
    #[test]
    fn export_escapes_formulas_reversibly_and_csv_preserves_multiline_arabic() {
        for text in [
            "=SUM(1,2)",
            "  +cmd",
            "@test",
            "-1",
            "\tvalue",
            "'=literal",
            "'hello",
            "مرحبا\nبكم, \"هنا\"",
        ] {
            assert_eq!(csv_unescape(&csv_escape(text)), text);
        }
        let mut b = bundle();
        b.overrides.push(Override {
            key: "cart.add".into(),
            locale: "ar".into(),
            form: "other".into(),
            text: "مرحبا\nبكم, \"هنا\"".into(),
            source_text: b.source("cart.add", "ar", "other").unwrap().into(),
        });
        let p = plan(&b, &csv_output(&b));
        assert!(p.errors.is_empty());
        assert!(p.changes.is_empty());
    }
}
