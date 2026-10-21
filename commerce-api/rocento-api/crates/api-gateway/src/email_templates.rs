//! Controlled transactional email copy: drafts, immutable publications and escaped rendering.
use crate::identity::{self, ApiError, App};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use infra_auth::{Error, Notification};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{types::Json as DbJson, FromRow, PgConnection, PgPool};
use std::collections::BTreeMap;
use uuid::Uuid;

const KEYS: [&str; 4] = ["verify", "reset", "order", "shipment"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub subject: String,
    pub heading: String,
    pub body: String,
    pub cta_label: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RenderedEmail {
    pub subject: String,
    pub text: String,
    pub html: String,
}
#[derive(Serialize)]
struct Variable {
    name: &'static str,
    description: &'static str,
    sample: String,
    required: bool,
}
struct Definition {
    key: &'static str,
    name: &'static str,
    description: &'static str,
    category: &'static str,
    variables: Vec<Variable>,
    content: Content,
}
fn definition(key: &str) -> infra_auth::Result<Definition> {
    let (key, name, description, category, subject, heading, body, cta) = match key {
        "verify" => ("verify", "Registration confirmation", "Verify a new customer's email address.", "account", "Verify your {{brand_name}} account", "Welcome to {{brand_name}}", "You're one step away from completing your account. Confirm that this email address belongs to you to continue.\n\nFor your security, this verification link expires {{expires_minutes}} minutes after it was requested.", Some("Confirm email address")),
        "reset" => ("reset", "Password reset", "Help customers securely reset their password.", "account", "Reset your {{brand_name}} password", "A fresh start for your account", "We received a request to reset the password for your {{brand_name}} account. Use the secure button below to choose a new password.\n\nFor your security, this reset link expires {{expires_minutes}} minutes after it was requested.", Some("Choose a new password")),
        "order" => ("order", "Order confirmation", "Confirm a placed order with its total and payment details.", "orders", "Your {{brand_name}} order confirmation", "Thank you for your order", "Thank you for shopping with {{brand_name}}. We have received your order and recorded the details below.\n\n{{message}}\n\nPlease keep this confirmation for your records.", None),
        "shipment" => ("shipment", "Shipment confirmation", "Notify customers when their order ships, including tracking details.", "orders", "Your {{brand_name}} order has shipped", "A shipment is on its way", "A shipment for your order has been dispatched. Review the shipment information below.\n\n{{message}}\n\nKeep these details for your records.", None),
        _ => return Err(Error::NotFound),
    };
    let mut variables = vec![Variable {
        name: "brand_name",
        description: "Store name",
        sample: "Rocento".into(),
        required: false,
    }];
    if category == "account" {
        variables.extend([
            Variable {
                name: "expires_minutes",
                description: "Link expiry in minutes; required in the body",
                sample: "15".into(),
                required: true,
            },
            Variable {
                name: "action_url",
                description: "Secure single-use link; also added automatically to the button",
                sample: "https://store.example.test/account/confirm?token=preview-only".into(),
                required: false,
            },
        ]);
    } else {
        variables.push(Variable {
            name: "message",
            description: "Order or shipment details; required in the body",
            sample: if key == "order" {
                "Order #1042 confirmed. Total: 125.50 EGP. Payment: Cash on Delivery."
            } else {
                "Order #1042 has shipped. Tracking reference: SAMPLE-1042"
            }
            .into(),
            required: true,
        });
    }
    Ok(Definition {
        key,
        name,
        description,
        category,
        variables,
        content: Content {
            subject: subject.into(),
            heading: heading.into(),
            body: body.into(),
            cta_label: cta.map(str::to_owned),
        },
    })
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn validate_text(value: &str, max: usize, multiline: bool) -> infra_auth::Result<()> {
    if value.trim().is_empty()
        || value.len() > max
        || value
            .chars()
            .any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\t')))
    {
        return Err(invalid(
            "Template fields are empty, too long, or contain invalid control characters",
        ));
    }
    Ok(())
}

/// A deliberately small template language: exact named tokens, with no expressions or HTML.
fn substitute(value: &str, values: &BTreeMap<&str, &str>) -> infra_auth::Result<String> {
    let mut rest = value;
    let mut output = String::new();
    while let Some(start) = rest.find("{{") {
        let prefix = &rest[..start];
        if prefix.contains(['{', '}']) {
            return Err(invalid(
                "Use exact named placeholders such as {{brand_name}}",
            ));
        }
        output.push_str(prefix);
        rest = &rest[start + 2..];
        let end = rest
            .find("}}")
            .ok_or_else(|| invalid("A template placeholder is incomplete"))?;
        let token = &rest[..end];
        let replacement = values
            .get(token)
            .ok_or_else(|| invalid("The template contains an unknown or malformed placeholder"))?;
        // Replacements are data: never recursively expand their content.
        output.push_str(replacement);
        rest = &rest[end + 2..];
    }
    if rest.contains(['{', '}']) {
        return Err(invalid(
            "Use exact named placeholders such as {{brand_name}}",
        ));
    }
    output.push_str(rest);
    Ok(output)
}
pub fn validate_content(key: &str, content: &Content) -> infra_auth::Result<()> {
    let d = definition(key)?;
    validate_text(&content.subject, 200, false)?;
    validate_text(&content.heading, 160, false)?;
    validate_text(&content.body, 12000, true)?;
    let values: BTreeMap<_, _> = d
        .variables
        .iter()
        .map(|v| (v.name, v.sample.as_str()))
        .collect();
    // Bound expansion for the largest supported event/link and 120-byte store name.
    // This guarantees that a validated draft remains within delivery body limits.
    for variable in &d.variables {
        let token = format!("{{{{{}}}}}", variable.name);
        let count: usize = [&content.subject, &content.heading, &content.body]
            .into_iter()
            .chain(content.cta_label.iter())
            .map(|field| field.matches(&token).count())
            .sum();
        let maximum = if matches!(variable.name, "message" | "action_url") {
            1
        } else {
            4
        };
        if count > maximum {
            return Err(invalid("A placeholder appears too many times; use message and action_url at most once and other placeholders at most four times"));
        }
    }
    for value in [&content.subject, &content.heading, &content.body] {
        substitute(value, &values)?;
    }
    // Multiline event details and credentials cannot be put into headers or headings.
    if [&content.subject, &content.heading]
        .iter()
        .any(|s| s.contains("{{message}}") || s.contains("{{action_url}}"))
    {
        return Err(invalid(
            "Message details and secure links are allowed only in the body",
        ));
    }
    for variable in d.variables.iter().filter(|v| v.required) {
        if !content.body.contains(&format!("{{{{{}}}}}", variable.name)) {
            return Err(invalid(
                "The body must include its required expiry or message placeholder",
            ));
        }
    }
    match (d.category, &content.cta_label) {
        ("account", Some(label)) => {
            validate_text(label, 80, false)?;
            substitute(label, &values)?;
            if label.contains("{{action_url}}") {
                return Err(invalid("The secure link cannot be used as button text"));
            }
        }
        ("account", None) => return Err(invalid("Account emails require a button label")),
        (_, Some(_)) => {
            return Err(invalid(
                "Order and shipment emails do not support an action button",
            ))
        }
        _ => {}
    }
    Ok(())
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
/// A single styled wrapper keeps output bounded even for thousands of paragraphs.
fn copy_html(value: &str) -> String {
    if value.trim().is_empty() {
        return String::new();
    }
    format!(
        r##"<p dir="auto" style="margin:0 0 18px;color:#435565;font-size:16px;line-height:1.75;overflow-wrap:anywhere;word-break:break-word">{}</p>"##,
        escape(value.trim_matches('\n')).replace('\n', "<br>")
    )
}

fn render(
    key: &str,
    content: &Content,
    values: &BTreeMap<&str, &str>,
) -> infra_auth::Result<RenderedEmail> {
    validate_content(key, content)?;
    let subject = substitute(&content.subject, values)?;
    validate_text(&subject, 998, false)?;
    let heading = substitute(&content.heading, values)?;
    let body = substitute(&content.body, values)?;
    let brand = values.get("brand_name").copied().unwrap_or("Rocento");
    let account = matches!(key, "verify" | "reset");
    let (eyebrow, preheader, context, details_title) = match key {
        "verify" => (
            "ACCOUNT CONFIRMATION",
            "Confirm your email address to complete your account setup.",
            "YOUR ACCOUNT",
            "",
        ),
        "reset" => (
            "ACCOUNT SECURITY",
            "Your secure password reset link is ready. It expires in 15 minutes.",
            "YOUR ACCOUNT",
            "",
        ),
        "order" => (
            "ORDER CONFIRMED",
            "Your order confirmation and payment details, all in one place.",
            "YOUR ORDER",
            "Order details",
        ),
        "shipment" => (
            "SHIPMENT DISPATCHED",
            "A shipment for your order is on its way. Find the shipment details inside.",
            "YOUR ORDER",
            "Shipment details",
        ),
        _ => return Err(Error::NotFound),
    };
    let body_html = if account {
        copy_html(&body)
    } else {
        // Split the authored placeholder, never parse or re-interpret event data.
        // The exact original message remains contiguous in the plain-text alternative.
        let (before, after) = content
            .body
            .split_once("{{message}}")
            .ok_or_else(|| invalid("The body must include its required message placeholder"))?;
        let message = values
            .get("message")
            .ok_or_else(|| invalid("Missing message details"))?;
        format!(
            r##"{}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:6px 0 24px;border:1px solid #dce9e2;border-collapse:separate;border-radius:12px;background:#f2f7f4"><tr><td style="padding:22px 24px"><p dir="auto" style="margin:0 0 10px;color:#30604c;font-size:12px;line-height:1.5;font-weight:700;letter-spacing:0.7px">{}</p><p dir="auto" style="margin:0;color:#19392d;font-size:16px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word">{}</p></td></tr></table>{}"##,
            copy_html(&substitute(before, values)?),
            escape(details_title),
            escape(message).replace('\n', "<br>"),
            copy_html(&substitute(after, values)?)
        )
    };
    let mut text = format!("{heading}\n\n{body}");
    let mut action_html = String::new();
    if let Some(label) = &content.cta_label {
        let url = values
            .get("action_url")
            .ok_or_else(|| invalid("Missing secure action link"))?;
        let parsed = reqwest::Url::parse(url).map_err(|_| invalid("Invalid secure action link"))?;
        if !matches!(parsed.scheme(), "https" | "http")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(invalid("Invalid secure action link"));
        }
        let label = substitute(label, values)?;
        text.push_str(&format!("\n\n{label}: {url}"));
        action_html = format!(
            r##"<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:8px 0 26px"><tr><td align="center" style="padding:8px 0"><table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate"><tr><td align="center" bgcolor="#08745a" style="border-radius:8px;background:#08745a;mso-padding-alt:16px 28px"><a href="{}" dir="auto" style="display:inline-block;border:1px solid #08745a;border-radius:8px;padding:16px 28px;color:#ffffff;background:#08745a;font-size:15px;line-height:1.5;font-weight:700;text-decoration:none;text-align:center;overflow-wrap:anywhere;word-break:break-word">{}</a></td></tr></table></td></tr></table><p dir="auto" style="margin:0 0 8px;color:#657686;font-size:12px;line-height:1.7">If the button doesn't work, copy and paste this link into your browser:</p><p dir="ltr" style="margin:0 0 28px;font-size:12px;line-height:1.8;overflow-wrap:anywhere;word-break:break-all"><a href="{}" dir="ltr" style="color:#08745a;text-decoration:underline;overflow-wrap:anywhere;word-break:break-all">{}</a></p>"##,
            escape(url),
            escape(&label),
            escape(url),
            escape(url)
        );
    }
    let security_html = if account {
        let security_note = "This link can only be used once. If you did not request this email, you can ignore it.";
        text.push_str(&format!("\n\n{security_note}"));
        format!(
            r##"<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:separate;border-radius:10px;background:#f2f5f8"><tr><td style="padding:18px 20px"><p dir="auto" style="margin:0 0 6px;color:#253e50;font-size:12px;line-height:1.5;font-weight:700">A note on security</p><p dir="auto" style="margin:0;color:#5c6f7f;font-size:12px;line-height:1.75">{security_note}</p></td></tr></table>"##
        )
    } else {
        String::new()
    };
    let footer = if account {
        "This email relates to your account activity."
    } else {
        "This email relates to your order activity."
    };
    text.push_str(&format!("\n\n{brand}\n{footer}"));
    // Inline styles and presentation tables support clients that omit head CSS.
    // No remote assets, user-supplied HTML, tracking pixels or inferred commerce links.
    let html = format!(
        r##"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>{subject}</title></head>
<body dir="auto" bgcolor="#edf2f5" style="margin:0;padding:0;width:100%;background:#edf2f5;color:#183244;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div aria-hidden="true" style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;mso-hide:all">{preheader}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#edf2f5" style="width:100%;border-collapse:collapse;background:#edf2f5"><tr><td align="center" style="padding:32px 12px">
<!--[if mso]><table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:640px;table-layout:fixed;border:1px solid #dbe4eb;border-collapse:separate;border-radius:16px;overflow:hidden;background:#ffffff">
<tr><td bgcolor="#112e40" style="padding:28px 32px;background:#112e40;border-radius:15px 15px 0 0"><p dir="auto" style="margin:0;color:#ffffff;font-size:26px;line-height:1.3;font-weight:700;letter-spacing:-0.7px;overflow-wrap:anywhere;word-break:break-word">{brand}</p><p dir="auto" style="margin:9px 0 0;color:#b7ccd7;font-size:10px;line-height:1.5;font-weight:700;letter-spacing:1.8px">{context}</p></td></tr>
<tr><td height="4" bgcolor="#2ba982" style="height:4px;line-height:4px;font-size:1px;background:#2ba982">&nbsp;</td></tr>
<tr><td style="padding:34px 32px 36px"><p dir="auto" style="margin:0 0 18px;color:#08745a;font-size:11px;line-height:1.5;font-weight:700;letter-spacing:1.1px">{eyebrow}</p><h1 dir="auto" style="margin:0 0 20px;color:#142f41;font-size:30px;line-height:1.25;font-weight:700;letter-spacing:-0.7px;overflow-wrap:anywhere;word-break:break-word">{heading}</h1>{body_html}{action_html}{security_html}</td></tr>
<tr><td bgcolor="#f7f9fb" style="padding:24px 32px;border-top:1px solid #e5ebf0;border-radius:0 0 15px 15px;background:#f7f9fb"><p dir="auto" style="margin:0 0 6px;color:#253e50;font-size:14px;line-height:1.5;font-weight:700;overflow-wrap:anywhere;word-break:break-word">{brand}</p><p dir="auto" style="margin:0;color:#788795;font-size:12px;line-height:1.65">{footer}</p></td></tr>
</table><!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>"##,
        subject = escape(&subject),
        preheader = escape(preheader),
        brand = escape(brand),
        context = escape(context),
        eyebrow = escape(eyebrow),
        heading = escape(&heading),
        footer = escape(footer)
    );
    Ok(RenderedEmail {
        subject,
        text,
        html,
    })
}
fn notification_values(n: &Notification) -> infra_auth::Result<BTreeMap<&str, &str>> {
    let mut values = BTreeMap::from([("brand_name", "Rocento")]);
    match n.purpose.as_str() {
        "verify" | "reset" => {
            validate_text(&n.link, 2048, false)?;
            values.insert("action_url", &n.link);
            values.insert("expires_minutes", "15");
        }
        "order" | "shipment" => {
            validate_text(&n.link, 2048, true)?;
            values.insert("message", &n.link);
        }
        _ => return Err(invalid("Unsupported email purpose")),
    }
    Ok(values)
}
pub fn render_builtin_notification(n: &Notification) -> infra_auth::Result<RenderedEmail> {
    if n.purpose == crate::login_alerts::PURPOSE {
        return crate::login_alerts::render_builtin(n);
    }
    render(
        &n.purpose,
        &definition(&n.purpose)?.content,
        &notification_values(n)?,
    )
}
pub async fn render_notification(
    pool: &PgPool,
    n: &Notification,
) -> infra_auth::Result<RenderedEmail> {
    render_notification_in(&mut *pool.acquire().await?, n).await
}
async fn store_name(connection: &mut PgConnection) -> infra_auth::Result<String> {
    let name: Option<String> =
        sqlx::query_scalar("SELECT site_name FROM cms.discoverability_settings WHERE singleton")
            .fetch_optional(connection)
            .await?;
    Ok(name
        .map(|name| name.trim().to_owned())
        .filter(|name| validate_text(name, 120, false).is_ok())
        .unwrap_or_else(|| "Rocento".into()))
}
pub async fn render_notification_in(
    connection: &mut PgConnection,
    n: &Notification,
) -> infra_auth::Result<RenderedEmail> {
    if n.purpose == crate::login_alerts::PURPOSE {
        return crate::login_alerts::render(n).await;
    }
    let builtin = definition(&n.purpose)?;
    let brand = store_name(&mut *connection).await?;
    let published: Option<DbJson<Content>> = sqlx::query_scalar("SELECT v.content FROM platform.email_templates t JOIN platform.email_template_versions v ON v.template_key=t.key AND v.version=t.published_version WHERE t.key=$1")
        .bind(&n.purpose).fetch_optional(connection).await?;
    let mut values = notification_values(n)?;
    values.insert("brand_name", &brand);
    render(
        &n.purpose,
        published.as_ref().map(|c| &c.0).unwrap_or(&builtin.content),
        &values,
    )
}

#[derive(FromRow)]
struct Record {
    key: String,
    id: Uuid,
    draft_content: Option<DbJson<Content>>,
    revision: i64,
    published_version: Option<i64>,
    published_content: Option<DbJson<Content>>,
    updated_at: Option<DateTime<Utc>>,
    updated_by: Option<Uuid>,
}
#[derive(Serialize)]
struct Template {
    key: &'static str,
    name: &'static str,
    description: &'static str,
    category: &'static str,
    variables: Vec<Variable>,
    revision: i64,
    draft: Content,
    published: Option<Content>,
    published_version: Option<i64>,
    has_unpublished_changes: bool,
    updated_at: Option<DateTime<Utc>>,
    updated_by: Option<Uuid>,
}
impl Record {
    fn template(self, brand: &str) -> infra_auth::Result<Template> {
        let mut d = definition(&self.key)?;
        d.variables[0].sample = brand.into();
        let draft = self
            .draft_content
            .map(|c| c.0)
            .unwrap_or_else(|| d.content.clone());
        let published = self.published_content.map(|c| c.0);
        let has_unpublished_changes = draft != *published.as_ref().unwrap_or(&d.content);
        Ok(Template {
            key: d.key,
            name: d.name,
            description: d.description,
            category: d.category,
            variables: d.variables,
            revision: self.revision,
            draft,
            published,
            published_version: self.published_version,
            has_unpublished_changes,
            updated_at: self.updated_at,
            updated_by: self.updated_by,
        })
    }
}
const SELECT: &str = "SELECT t.key,t.id,t.draft_content,t.revision,t.published_version,v.content AS published_content,t.updated_at,t.updated_by FROM platform.email_templates t LEFT JOIN platform.email_template_versions v ON v.template_key=t.key AND v.version=t.published_version";
async fn record(
    connection: &mut PgConnection,
    key: &str,
    lock: bool,
) -> infra_auth::Result<Record> {
    definition(key)?;
    sqlx::query_as(&format!(
        "{SELECT} WHERE t.key=$1{}",
        if lock { " FOR UPDATE OF t" } else { "" }
    ))
    .bind(key)
    .fetch_optional(connection)
    .await?
    .ok_or(Error::NotFound)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveInput {
    expected_revision: i64,
    content: Content,
    change_note: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublishInput {
    expected_revision: i64,
    change_note: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreInput {
    expected_revision: i64,
    version: i64,
    change_note: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewInput {
    content: Content,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryQuery {
    before_version: Option<i64>,
}
#[derive(Serialize, FromRow)]
struct Version {
    version: i64,
    content: DbJson<Content>,
    change_note: String,
    published_at: DateTime<Utc>,
    published_by: Uuid,
}
struct TemplateError(Error);
impl From<Error> for TemplateError {
    fn from(value: Error) -> Self {
        Self(value)
    }
}
impl From<sqlx::Error> for TemplateError {
    fn from(value: sqlx::Error) -> Self {
        Self(value.into())
    }
}
impl IntoResponse for TemplateError {
    fn into_response(self) -> Response {
        if matches!(self.0, Error::Conflict) {
            response(
                StatusCode::CONFLICT,
                json!({"error":"This template changed after you opened it. Reload it before saving or publishing.","code":"stale_revision"}),
            )
        } else {
            ApiError::from(self.0).into_response()
        }
    }
}
type ApiResult = std::result::Result<Response, TemplateError>;
fn response(status: StatusCode, value: impl Serialize) -> Response {
    let mut response = (status, Json(value)).into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}
fn input<T>(value: std::result::Result<Json<T>, JsonRejection>) -> infra_auth::Result<T> {
    value
        .map(|v| v.0)
        .map_err(|_| invalid("Invalid email template request"))
}
fn change(revision: i64, note: &str) -> infra_auth::Result<()> {
    if revision < 0
        || note.trim().chars().count() < 3
        || note.chars().count() > 500
        || note.chars().any(char::is_control)
    {
        return Err(invalid(
            "A valid revision and a change note of 3 to 500 characters are required",
        ));
    }
    Ok(())
}
async fn authorize(a: &App, h: &HeaderMap, permission: &str) -> infra_auth::Result<Uuid> {
    let who = a
        .admins
        .authenticate(identity::cookie(h, "admin_session"))
        .await?;
    who.require("email_templates.read")?;
    who.require(permission)?;
    Ok(who.user.id)
}
pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/admin/email-templates", get(list))
        .route("/v1/admin/email-templates/{key}", get(detail).put(save))
        .route("/v1/admin/email-templates/{key}/preview", post(preview))
        .route("/v1/admin/email-templates/{key}/publish", post(publish))
        .route("/v1/admin/email-templates/{key}/history", get(history))
        .route("/v1/admin/email-templates/{key}/restore", post(restore))
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            identity::policy,
        ))
        .with_state(app)
}
async fn list(State(a): State<App>, h: HeaderMap) -> ApiResult {
    authorize(&a, &h, "email_templates.read").await?;
    let mut records: Vec<Record> = sqlx::query_as(SELECT).fetch_all(&a.admins.pool).await?;
    records.sort_by_key(|r| KEYS.iter().position(|key| *key == r.key).unwrap_or(4));
    let brand = store_name(&mut *a.admins.pool.acquire().await?).await?;
    let items = records
        .into_iter()
        .map(|r| r.template(&brand))
        .collect::<infra_auth::Result<Vec<_>>>()?;
    Ok(response(StatusCode::OK, json!({"items":items})))
}
async fn detail(State(a): State<App>, h: HeaderMap, Path(key): Path<String>) -> ApiResult {
    authorize(&a, &h, "email_templates.read").await?;
    let mut connection = a.admins.pool.acquire().await?;
    let brand = store_name(&mut connection).await?;
    Ok(response(
        StatusCode::OK,
        record(&mut connection, &key, false)
            .await?
            .template(&brand)?,
    ))
}
async fn preview(
    State(a): State<App>,
    h: HeaderMap,
    Path(key): Path<String>,
    body: std::result::Result<Json<PreviewInput>, JsonRejection>,
) -> ApiResult {
    let actor = authorize(&a, &h, "email_templates.read").await?;
    infra_auth::rate_limit(&a.admins.pool, &format!("email-preview:{actor}"), 600).await?;
    let body = input(body)?;
    let d = definition(&key)?;
    let brand = store_name(&mut *a.admins.pool.acquire().await?).await?;
    let mut values: BTreeMap<_, _> = d
        .variables
        .iter()
        .map(|v| (v.name, v.sample.as_str()))
        .collect();
    values.insert("brand_name", &brand);
    Ok(response(
        StatusCode::OK,
        render(&key, &body.content, &values)?,
    ))
}
async fn save(
    State(a): State<App>,
    h: HeaderMap,
    Path(key): Path<String>,
    body: std::result::Result<Json<SaveInput>, JsonRejection>,
) -> ApiResult {
    let actor = authorize(&a, &h, "email_templates.write").await?;
    let body = input(body)?;
    change(body.expected_revision, &body.change_note)?;
    validate_content(&key, &body.content)?;
    infra_auth::rate_limit(&a.admins.pool, &format!("email-edit:{actor}"), 60).await?;
    let mut tx = a.admins.pool.begin().await?;
    let current = record(&mut tx, &key, true).await?;
    if current.revision != body.expected_revision {
        return Err(Error::Conflict.into());
    }
    sqlx::query("UPDATE platform.email_templates SET draft_content=$2,revision=revision+1,updated_at=clock_timestamp(),updated_by=$3 WHERE key=$1")
        .bind(&key).bind(DbJson(&body.content)).bind(actor).execute(&mut *tx).await?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(actor),
        "email_templates.draft_saved",
        current.id,
        json!({"key":key,"revision":current.revision+1,"change_note":body.change_note}),
    )
    .await?;
    let brand = store_name(&mut tx).await?;
    let template = record(&mut tx, &key, false).await?.template(&brand)?;
    tx.commit().await?;
    Ok(response(StatusCode::OK, template))
}
async fn publish(
    State(a): State<App>,
    h: HeaderMap,
    Path(key): Path<String>,
    body: std::result::Result<Json<PublishInput>, JsonRejection>,
) -> ApiResult {
    let actor = authorize(&a, &h, "email_templates.publish").await?;
    let body = input(body)?;
    change(body.expected_revision, &body.change_note)?;
    infra_auth::rate_limit(&a.admins.pool, &format!("email-publish:{actor}"), 30).await?;
    let mut tx = a.admins.pool.begin().await?;
    let current = record(&mut tx, &key, true).await?;
    if current.revision != body.expected_revision {
        return Err(Error::Conflict.into());
    }
    let content = current
        .draft_content
        .as_ref()
        .map(|c| c.0.clone())
        .unwrap_or(definition(&key)?.content);
    validate_content(&key, &content)?;
    let version = current.published_version.unwrap_or(0) + 1;
    sqlx::query("INSERT INTO platform.email_template_versions(template_key,version,content,change_note,published_by) VALUES($1,$2,$3,$4,$5)")
        .bind(&key).bind(version).bind(DbJson(&content)).bind(&body.change_note).bind(actor).execute(&mut *tx).await?;
    sqlx::query("UPDATE platform.email_templates SET published_version=$2,revision=revision+1,updated_at=clock_timestamp(),updated_by=$3 WHERE key=$1")
        .bind(&key).bind(version).bind(actor).execute(&mut *tx).await?;
    domain_admin_iam::Service::audit(&mut tx, Some(actor), "email_templates.published", current.id, json!({"key":key,"revision":current.revision+1,"version":version,"change_note":body.change_note})).await?;
    let brand = store_name(&mut tx).await?;
    let template = record(&mut tx, &key, false).await?.template(&brand)?;
    tx.commit().await?;
    Ok(response(StatusCode::OK, template))
}
async fn history(
    State(a): State<App>,
    h: HeaderMap,
    Path(key): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> ApiResult {
    authorize(&a, &h, "email_templates.read").await?;
    definition(&key)?;
    if query.before_version.is_some_and(|v| v < 1) {
        return Err(invalid("Invalid history cursor").into());
    }
    let mut items: Vec<Version> = sqlx::query_as("SELECT version,content,change_note,published_at,published_by FROM platform.email_template_versions WHERE template_key=$1 AND ($2::bigint IS NULL OR version<$2) ORDER BY version DESC LIMIT 51")
        .bind(&key).bind(query.before_version).fetch_all(&a.admins.pool).await?;
    let next = if items.len() > 50 {
        items.truncate(50);
        items.last().map(|v| v.version)
    } else {
        None
    };
    Ok(response(
        StatusCode::OK,
        json!({"items":items,"next_before_version":next}),
    ))
}
async fn restore(
    State(a): State<App>,
    h: HeaderMap,
    Path(key): Path<String>,
    body: std::result::Result<Json<RestoreInput>, JsonRejection>,
) -> ApiResult {
    let actor = authorize(&a, &h, "email_templates.write").await?;
    let body = input(body)?;
    change(body.expected_revision, &body.change_note)?;
    if body.version < 1 {
        return Err(invalid("Invalid publication version").into());
    }
    infra_auth::rate_limit(&a.admins.pool, &format!("email-edit:{actor}"), 60).await?;
    let mut tx = a.admins.pool.begin().await?;
    let current = record(&mut tx, &key, true).await?;
    if current.revision != body.expected_revision {
        return Err(Error::Conflict.into());
    }
    let content: DbJson<Content> = sqlx::query_scalar(
        "SELECT content FROM platform.email_template_versions WHERE template_key=$1 AND version=$2",
    )
    .bind(&key)
    .bind(body.version)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    validate_content(&key, &content.0)?;
    sqlx::query("UPDATE platform.email_templates SET draft_content=$2,revision=revision+1,updated_at=clock_timestamp(),updated_by=$3 WHERE key=$1")
        .bind(&key).bind(&content).bind(actor).execute(&mut *tx).await?;
    domain_admin_iam::Service::audit(&mut tx, Some(actor), "email_templates.restored", current.id, json!({"key":key,"revision":current.revision+1,"restored_version":body.version,"change_note":body.change_note})).await?;
    let brand = store_name(&mut tx).await?;
    let template = record(&mut tx, &key, false).await?.template(&brand)?;
    tx.commit().await?;
    Ok(response(StatusCode::OK, template))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn notification(purpose: &str) -> Notification {
        Notification {
            identifier: "customer@example.test".into(),
            purpose: purpose.into(),
            code: "secret-code".into(),
            mobile: false,
            link: if matches!(purpose, "verify" | "reset") {
                "https://store.example.test/verify?token=sample&test=1".into()
            } else {
                "Order <script>alert('x')</script> & {{brand_name}}".into()
            },
        }
    }
    #[test]
    fn builtins_render_all_supported_notifications_safely() {
        for key in KEYS {
            let rendered = render_builtin_notification(&notification(key)).unwrap();
            assert!(rendered.subject.contains("Rocento"));
            assert!(!rendered.html.contains("<script>"));
            assert!(!rendered.html.contains("secret-code"));
            if matches!(key, "verify" | "reset") {
                assert!(rendered.text.contains("15 minutes"));
                assert!(rendered.html.contains("token=sample&amp;test=1"));
            } else {
                assert!(rendered.html.contains("&lt;script&gt;"));
                assert!(rendered.text.contains("{{brand_name}}"));
            }
        }
    }
    #[test]
    fn content_validation_rejects_unsafe_headers_and_unknown_tokens() {
        let base = definition("verify").unwrap().content;
        for subject in [
            "Hello\r\nBcc: bad@example.test",
            "{{unknown}}",
            "{{ brand_name }}",
            "{{brand_name",
            "Hello }",
            "{{action_url}}",
        ] {
            assert!(
                validate_content(
                    "verify",
                    &Content {
                        subject: subject.into(),
                        ..base.clone()
                    }
                )
                .is_err(),
                "{subject}"
            );
        }
        assert!(validate_content(
            "verify",
            &Content {
                body: "No expiry".into(),
                ..base.clone()
            }
        )
        .is_err());
        assert!(validate_content(
            "verify",
            &Content {
                cta_label: None,
                ..base
            }
        )
        .is_err());
        let commerce = definition("order").unwrap().content;
        assert!(validate_content(
            "order",
            &Content {
                body: "No order details".into(),
                ..commerce.clone()
            }
        )
        .is_err());
        assert!(validate_content(
            "order",
            &Content {
                subject: "{{message}}".into(),
                ..commerce
            }
        )
        .is_err());
    }
    #[test]
    fn html_is_always_escaped_and_never_interpreted() {
        let mut content = definition("order").unwrap().content;
        content.heading = "<img src=x onerror=alert(1)>".into();
        content.body = "<a href=\"javascript:alert(1)\">Click</a>\n{{message}}".into();
        let rendered = render(
            "order",
            &content,
            &notification_values(&notification("order")).unwrap(),
        )
        .unwrap();
        assert!(!rendered.html.contains("<img"));
        assert!(!rendered.html.contains("<a href=\"javascript:"));
        assert!(rendered.html.contains("&lt;img"));
    }
    #[test]
    fn malformed_links_and_payloads_are_not_rendered() {
        for link in [
            "javascript:alert(1)",
            "https://user:password@store.example.test/verify",
        ] {
            let mut n = notification("verify");
            n.link = link.into();
            assert!(render_builtin_notification(&n).is_err());
        }
        let mut n = notification("order");
        n.link = "x".repeat(2049);
        assert!(render_builtin_notification(&n).is_err());
    }
    #[test]
    fn placeholder_limits_keep_worst_case_email_inside_delivery_bounds() {
        let mut content = definition("order").unwrap().content;
        content.body = "{{message}}".repeat(2);
        assert!(validate_content("order", &content).is_err());
        content.body = "{{message}}".into();
        content.subject = "{{brand_name}}".repeat(5);
        assert!(validate_content("order", &content).is_err());
        content.subject = "{{brand_name}}".repeat(4);
        content.body = format!("{}{{{{message}}}}", "\"".repeat(11989));
        let brand = "\"".repeat(120);
        let message = "\"".repeat(2048);
        let values = BTreeMap::from([
            ("brand_name", brand.as_str()),
            ("message", message.as_str()),
        ]);
        let rendered = render("order", &content, &values).unwrap();
        assert!(rendered.subject.len() <= 998);
        assert!(rendered.text.len() <= 128 * 1024);
        assert!(rendered.html.len() <= 256 * 1024);
    }
    #[test]
    fn thousands_of_valid_paragraphs_cannot_overflow_delivery_limits() {
        let mut content = definition("order").unwrap().content;
        let copy = "a\n\n".repeat(3990);
        content.body = format!("{copy}{{{{message}}}}");
        let message = "\"".repeat(2048);
        let values = BTreeMap::from([("brand_name", "Rocento"), ("message", message.as_str())]);
        let rendered = render("order", &content, &values).unwrap();
        assert!(rendered.text.contains(&format!("{copy}{message}")));
        assert!(rendered.html.matches("a<br><br>").count() >= 3989);
        assert!(rendered.text.len() <= 128 * 1024);
        assert!(rendered.html.len() <= 256 * 1024);
    }
    #[test]
    fn professional_layout_is_self_contained_and_account_links_have_a_fallback() {
        for key in KEYS {
            let n = notification(key);
            let rendered = render_builtin_notification(&n).unwrap();
            assert!(rendered.html.contains("max-width:640px"));
            assert!(rendered.html.contains("<table role=\"presentation\""));
            assert!(rendered.html.contains("mso-hide:all"));
            assert!(rendered.html.contains("dir=\"auto\""));
            assert!(!rendered.html.contains("<img"));
            assert!(!rendered.html.contains("<script"));
            assert!(!rendered.html.contains("<link"));
            assert!(!rendered.html.contains("url("));
            if matches!(key, "verify" | "reset") {
                assert!(rendered
                    .html
                    .contains("copy and paste this link into your browser"));
                assert_eq!(rendered.html.matches(&escape(&n.link)).count(), 3);
                assert!(rendered.html.contains("A note on security"));
                assert!(rendered.text.contains("only be used once"));
                let preheader = rendered
                    .html
                    .split("<div aria-hidden=\"true\"")
                    .nth(1)
                    .unwrap()
                    .split("</div>")
                    .next()
                    .unwrap();
                assert!(!preheader.contains("token="));
            } else {
                assert!(!rendered.html.contains("<a "));
                assert!(!rendered.html.contains("A note on security"));
            }
        }
    }
    #[test]
    fn commerce_details_are_preserved_without_parsing_or_fabricating_order_fields() {
        let message = "Order #42 has shipped. Tracking reference: <a href=\"https://tracking.example/\">REF & 01</a>\nParcel 2\t{{brand_name}}";
        let mut n = notification("shipment");
        n.link = message.into();
        let mut content = definition("shipment").unwrap().content;
        content.body =
            "Custom text before the details.\n\n{{message}}\n\nCustom text after the details."
                .into();
        let rendered = render("shipment", &content, &notification_values(&n).unwrap()).unwrap();
        assert_eq!(rendered.text.matches(message).count(), 1);
        assert!(rendered
            .html
            .contains(&escape(message).replace('\n', "<br>")));
        assert!(!rendered
            .html
            .contains("<a href=\"https://tracking.example/"));
        assert!(rendered.html.contains("Shipment details"));
        assert!(
            rendered.html.find("Custom text before").unwrap()
                < rendered.html.find("Shipment details").unwrap()
        );
        assert!(
            rendered.html.find("Shipment details").unwrap()
                < rendered.html.find("Custom text after").unwrap()
        );
        for invented in [
            "Delivery address",
            "Estimated arrival",
            "Track your order",
            "Items in your order",
        ] {
            assert!(!rendered.html.contains(invented));
        }
    }
    #[test]
    fn custom_arabic_copy_keeps_automatic_direction_and_ltr_fallback_links() {
        let mut content = definition("verify").unwrap().content;
        content.heading = "مرحباً بك في {{brand_name}}".into();
        content.body =
            "أكد عنوان بريدك الإلكتروني. تنتهي صلاحية الرابط بعد {{expires_minutes}} دقيقة.".into();
        content.cta_label = Some("تأكيد البريد الإلكتروني".into());
        let n = notification("verify");
        let rendered = render("verify", &content, &notification_values(&n).unwrap()).unwrap();
        assert!(rendered.html.contains("<h1 dir=\"auto\""));
        assert!(rendered.html.contains("مرحباً بك في Rocento"));
        assert!(rendered.text.contains("بعد 15 دقيقة"));
        assert!(rendered.html.contains("<p dir=\"ltr\""));
        assert!(rendered.html.contains("تأكيد البريد الإلكتروني"));
    }
}
