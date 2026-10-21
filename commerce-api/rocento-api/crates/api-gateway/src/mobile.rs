//! App Studio control plane; does not change commerce tenant isolation.
mod asset_library;
mod catalog;
mod preview;
mod preview_ec2;
mod preview_worker;
use crate::identity::{self, App};
use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use domain_mobile::{service::Service, *};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;
#[derive(Clone)]
struct MobileApp {
    identity: App,
    service: Service,
    media: Option<infra_media::Store>,
}
struct MobileError(Error);
impl From<Error> for MobileError {
    fn from(e: Error) -> Self {
        Self(e)
    }
}
impl IntoResponse for MobileError {
    fn into_response(self) -> Response {
        let status = match &self.0 {
            Error::Forbidden => StatusCode::FORBIDDEN,
            Error::Unauthorized => StatusCode::UNAUTHORIZED,
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::Conflict => StatusCode::CONFLICT,
            Error::Invalid(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Error::Incompatible => StatusCode::CONFLICT,
            Error::Storage => StatusCode::SERVICE_UNAVAILABLE,
            Error::RateLimited => StatusCode::TOO_MANY_REQUESTS,
        };
        let issues = match &self.0 {
            Error::Invalid(issues) => json!(issues),
            _ => json!([]),
        };
        let mut response = (
            status,
            [("cache-control", "no-store")],
            Json(json!({"error":self.0.to_string(),"issues":issues})),
        )
            .into_response();
        if status == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert("retry-after", "900".parse().unwrap());
        }
        response
    }
}
type ApiResult<T> = std::result::Result<T, MobileError>;
impl MobileApp {
    async fn actor(&self, h: &HeaderMap) -> ApiResult<Uuid> {
        self.actor_budget(h, "mobile-admin", 600).await
    }
    async fn preview_reader(&self, h: &HeaderMap) -> ApiResult<Uuid> {
        // Status polling (3s + 5s) must not exhaust editing or cleanup requests.
        self.actor_budget(h, "mobile-preview-read", 1800).await
    }
    async fn actor_budget(&self, h: &HeaderMap, bucket: &str, budget: i32) -> ApiResult<Uuid> {
        let who = self
            .identity
            .admins
            .authenticate(identity::cookie(h, "admin_session"))
            .await
            .map_err(|error| match error {
                infra_auth::Error::Database(_) => Error::Storage,
                _ => Error::Unauthorized,
            })?;
        infra_auth::rate_limit(
            &self.identity.admins.pool,
            &format!("{bucket}:{}", who.user.id),
            budget,
        )
        .await
        .map_err(|e| {
            MobileError(match e {
                infra_auth::Error::RateLimited => Error::RateLimited,
                _ => Error::Storage,
            })
        })?;
        Ok(who.user.id)
    }
}
async fn limit(pool: &sqlx::PgPool, subject: &str) -> ApiResult<()> {
    infra_auth::rate_limit(pool, subject, 600)
        .await
        .map_err(|e| {
            MobileError(match e {
                infra_auth::Error::RateLimited => Error::RateLimited,
                _ => Error::Storage,
            })
        })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    environment: Environment,
    before_version: Option<i64>,
    before_id: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MobileQuery {
    platform: Platform,
    runtime_version: String,
    locale: String,
}
pub fn router(identity: App) -> Router {
    router_with_media(identity, None)
}
pub fn router_with_media(identity: App, media: Option<infra_media::Store>) -> Router {
    let state = MobileApp {
        service: Service {
            pool: identity.admins.pool.clone(),
        },
        identity: identity.clone(),
        media,
    };
    Router::new()
        .route("/v1/mobile/merchants", get(merchants))
        .route(
            "/v1/merchants/{merchant}/app-preview/instance",
            get(preview_ec2::status).post(preview_ec2::control),
        )
        .route(
            "/v1/merchants/{merchant}/app-preview/sessions",
            post(preview::start),
        )
        .route(
            "/v1/merchants/{merchant}/app-preview/sessions/{session}",
            get(preview::status).delete(preview::stop),
        )
        .route(
            "/v1/merchants/{merchant}/app-preview/sessions/worker",
            post(preview_worker::start),
        )
        .route(
            "/v1/merchants/{merchant}/app-preview/sessions/{session}/frame",
            get(preview_worker::frame),
        )
        .route(
            "/v1/merchants/{merchant}/app-preview/sessions/{session}/video",
            get(preview_worker::video),
        )
        .route(
            "/v1/merchants/{merchant}/app-preview/sessions/{session}/input",
            post(preview_worker::input).layer(DefaultBodyLimit::max(2048)),
        )
        .route(
            "/v1/merchants/{merchant}/app-preview/catalog",
            get(catalog::preview),
        )
        .route(
            "/v1/merchants/{merchant}/app-preview/products/{product}",
            get(catalog::product),
        )
        .route(
            "/v1/merchants/{merchant}/app-preview/categories",
            get(catalog::categories),
        )
        .route(
            "/v1/merchants/{merchant}/app-devices/identities",
            get(native_identities),
        )
        .route(
            "/v1/merchants/{merchant}/app-devices/invitations",
            post(invite_device),
        )
        .route("/v1/merchants/{merchant}/app-devices", get(native_devices))
        .route(
            "/v1/merchants/{merchant}/app-devices/{device}/revoke",
            post(revoke_device),
        )
        .route("/v1/mobile/enroll", post(enroll_device))
        .route("/v1/mobile/session", post(renew_device))
        .route(
            "/v1/merchants/{merchant}/assets",
            get(assets)
                .post(upload)
                .layer(DefaultBodyLimit::max(5 * 1024 * 1024 + 4096)),
        )
        .route(
            "/v1/merchants/{merchant}/assets/{asset}/content",
            get(asset_content),
        )
        .route(
            "/v1/merchants/{merchant}/asset-library",
            get(asset_library::library),
        )
        .route(
            "/v1/merchants/{merchant}/asset-folders",
            get(asset_library::folders).post(asset_library::create),
        )
        .route(
            "/v1/merchants/{merchant}/asset-folders/{folder}",
            axum::routing::put(asset_library::save).delete(asset_library::delete),
        )
        .route(
            "/v1/merchants/{merchant}/assets/move",
            post(asset_library::move_assets),
        )
        .route(
            "/v1/merchants/{merchant}/assets/{asset}",
            axum::routing::put(asset_library::rename),
        )
        .route("/v1/merchants/{merchant}/app-config/audit", get(audits))
        .route(
            "/v1/merchants/{merchant}/app-config/draft",
            get(draft).put(save),
        )
        .route(
            "/v1/merchants/{merchant}/app-config/validate",
            post(validate),
        )
        .route("/v1/merchants/{merchant}/app-config/publish", post(publish))
        .route(
            "/v1/merchants/{merchant}/app-config/versions",
            get(versions),
        )
        .route(
            "/v1/merchants/{merchant}/app-config/rollback",
            post(rollback),
        )
        .route(
            "/v1/merchants/{merchant}/app-builds",
            get(builds).post(queue_build),
        )
        .route("/v1/merchants/{merchant}/app-builds/{build}", get(build))
        .layer(middleware::from_fn_with_state(identity, identity::policy))
        .route("/v1/mobile/preview/{session}", get(preview::snapshot))
        .route("/v1/mobile/preview/{session}/ack", post(preview::ack))
        .route(
            "/v1/mobile/preview/{session}/assets/{asset}",
            get(preview::asset),
        )
        .route("/v1/mobile/config", get(resolve))
        .route("/v1/mobile/assets/{asset}/content", get(native_asset))
        .layer(DefaultBodyLimit::max(MAX_BYTES + 4096))
        .layer(middleware::map_response(
            |mut response: Response| async move {
                if !response.headers().contains_key("cache-control") {
                    response
                        .headers_mut()
                        .insert("cache-control", "no-store".parse().unwrap());
                }
                response
            },
        ))
        .with_state(state)
}
fn key(h: &HeaderMap) -> ApiResult<&str> {
    h.get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| invalid("/Idempotency-Key", "IDEMPOTENCY_KEY_REQUIRED").into())
}
async fn draft(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
) -> ApiResult<Json<Draft>> {
    Ok(Json(
        a.service
            .draft(merchant, q.environment, a.actor(&h).await?)
            .await?,
    ))
}
async fn save(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
    Json(i): Json<SaveDraft>,
) -> ApiResult<Json<Draft>> {
    Ok(Json(
        a.service
            .save(merchant, q.environment, a.actor(&h).await?, i)
            .await?,
    ))
}
async fn validate(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    a.service
        .validate(merchant, q.environment, a.actor(&h).await?)
        .await?;
    Ok(Json(json!({"valid":true})))
}
async fn publish(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
    Json(i): Json<Publish>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        a.service
            .publish(
                merchant,
                q.environment,
                a.actor(&h).await?,
                i.expected_revision,
                None,
                key(&h)?,
            )
            .await?,
    ))
}
async fn rollback(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
    Json(i): Json<Rollback>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        a.service
            .publish(
                merchant,
                q.environment,
                a.actor(&h).await?,
                i.expected_revision,
                Some(i.target_version),
                key(&h)?,
            )
            .await?,
    ))
}
async fn versions(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
) -> ApiResult<Json<Vec<Version>>> {
    Ok(Json(
        a.service
            .versions(
                merchant,
                q.environment,
                a.actor(&h).await?,
                q.before_version.unwrap_or(i64::MAX),
            )
            .await?,
    ))
}
async fn builds(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
) -> ApiResult<Json<Vec<Build>>> {
    Ok(Json(
        a.service
            .builds(merchant, q.environment, a.actor(&h).await?)
            .await?,
    ))
}
async fn build(
    State(a): State<MobileApp>,
    Path((merchant, build)): Path<(Uuid, Uuid)>,
    Query(q): Query<Scope>,
    h: HeaderMap,
) -> ApiResult<Json<Build>> {
    Ok(Json(
        a.service
            .build(merchant, q.environment, a.actor(&h).await?, build)
            .await?,
    ))
}
async fn queue_build(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
    Json(i): Json<QueueBuild>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::ACCEPTED,
        Json(
            a.service
                .queue_build(merchant, q.environment, a.actor(&h).await?, i, key(&h)?)
                .await?,
        ),
    ))
}
async fn resolve(
    State(a): State<MobileApp>,
    Query(q): Query<MobileQuery>,
    h: HeaderMap,
) -> ApiResult<Response> {
    let token = identity::bearer(&h).map_err(|_| Error::Unauthorized)?;
    // Authentication, expiry and compatibility are checked even for a cached request.
    let row = a
        .service
        .resolve(token, q.platform, &q.runtime_version, &q.locale)
        .await?;
    limit(
        &a.identity.admins.pool,
        &format!("mobile-session:{}", token_hash(token)),
    )
    .await?;
    let etag = format!("\"mobile-{}\"", row.checksum);
    let matched = h
        .get("if-none-match")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',').any(|part| {
                let part = part.trim();
                part == "*" || part.strip_prefix("W/").unwrap_or(part) == etag
            })
        });
    let mut response = if matched {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        Json(row.config).into_response()
    };
    response.headers_mut().insert("etag", etag.parse().unwrap());
    response
        .headers_mut()
        .insert("x-config-checksum", row.checksum.parse().unwrap());
    response
        .headers_mut()
        .insert("cache-control", "private, no-cache".parse().unwrap());
    response
        .headers_mut()
        .insert("vary", "Authorization".parse().unwrap());
    Ok(response)
}

async fn merchants(
    State(a): State<MobileApp>,
    h: HeaderMap,
) -> ApiResult<Json<Vec<studio::Merchant>>> {
    Ok(Json(a.service.merchants(a.actor(&h).await?).await?))
}
async fn assets(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
) -> ApiResult<Json<Vec<studio::Asset>>> {
    Ok(Json(
        a.service
            .assets(merchant, a.actor(&h).await?, q.before_id)
            .await?,
    ))
}
async fn audits(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
) -> ApiResult<Json<Vec<studio::AuditEvent>>> {
    Ok(Json(
        a.service
            .audits(merchant, q.environment, a.actor(&h).await?, q.before_id)
            .await?,
    ))
}
async fn asset_content(
    State(a): State<MobileApp>,
    Path((merchant, asset)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
) -> ApiResult<Response> {
    let key = a
        .service
        .asset_object(merchant, a.actor(&h).await?, asset)
        .await?;
    let bytes = a
        .media
        .as_ref()
        .ok_or(Error::Storage)?
        .get(&key)
        .await
        .map_err(|_| Error::Storage)?;
    Ok((
        [
            ("content-type", "image/png"),
            ("cache-control", "private, no-store"),
            ("x-content-type-options", "nosniff"),
        ],
        bytes,
    )
        .into_response())
}
fn prepare_image(bytes: &[u8]) -> domain_mobile::Result<(Vec<u8>, i32, i32)> {
    use image::{ImageFormat, ImageReader};
    use std::io::Cursor;
    if bytes.len() > 5 * 1024 * 1024 {
        return Err(invalid("/file", "IMAGE_TOO_LARGE"));
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| invalid("/file", "INVALID_IMAGE"))?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)
    ) {
        return Err(invalid("/file", "INVALID_IMAGE"));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| invalid("/file", "INVALID_IMAGE"))?;
    let mut out = Cursor::new(Vec::new());
    decoded
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|_| invalid("/file", "INVALID_IMAGE"))?;
    if out.get_ref().len() > 5 * 1024 * 1024 {
        return Err(invalid("/file", "IMAGE_TOO_LARGE"));
    }
    Ok((
        out.into_inner(),
        decoded.width() as i32,
        decoded.height() as i32,
    ))
}
async fn upload(
    State(a): State<MobileApp>,
    Path(merchant): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<studio::Asset>)> {
    let actor = a.actor(&h).await?;
    a.service
        .authorize(merchant, actor, service::Access::Edit)
        .await?;
    let mut file = None;
    let mut name = None;
    let mut folder_id = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| invalid("/file", "INVALID_IMAGE"))?
    {
        match field.name() {
            Some("file") if file.is_none() => {
                file = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|_| invalid("/file", "INVALID_IMAGE"))?,
                )
            }
            Some("folderId") if folder_id.is_none() => {
                let value = field
                    .text()
                    .await
                    .map_err(|_| invalid("/folderId", "INVALID_FOLDER"))?;
                folder_id = Some(
                    Uuid::parse_str(&value).map_err(|_| invalid("/folderId", "INVALID_FOLDER"))?,
                );
            }
            Some("name") if name.is_none() => {
                name = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| invalid("/name", "INVALID_ASSET_NAME"))?,
                )
            }
            _ => return Err(invalid("/file", "INVALID_UPLOAD_FIELDS").into()),
        }
    }
    let name = name.unwrap_or_default();
    if name.trim().is_empty() || name.len() > 200 || name.chars().any(char::is_control) {
        return Err(invalid("/name", "INVALID_ASSET_NAME").into());
    }
    let file = file.ok_or_else(|| invalid("/file", "INVALID_IMAGE"))?;
    let (bytes, width, height) = tokio::task::spawn_blocking(move || prepare_image(&file))
        .await
        .map_err(|_| Error::Storage)??;
    let id = Uuid::new_v4();
    let key = format!("mobile/{merchant}/{id}");
    let storage = a.media.as_ref().ok_or(Error::Storage)?;
    storage
        .put(&key, &bytes, "image/png")
        .await
        .map_err(|_| Error::Storage)?;
    // Hash the sanitized bytes, rather than untrusted upload metadata.
    let checksum = domain_mobile::bytes_checksum(&bytes);
    match a
        .service
        .upload(
            merchant,
            q.environment,
            actor,
            studio::Upload {
                folder_id,
                id,
                name,
                width,
                height,
                size_bytes: bytes.len() as i64,
                checksum,
            },
        )
        .await
    {
        Ok(asset) => Ok((StatusCode::CREATED, Json(asset))),
        Err(error) => {
            let _ = storage.delete(&key).await;
            Err(error.into())
        }
    }
}

async fn native_identities(
    State(a): State<MobileApp>,
    Path(m): Path<Uuid>,
    h: HeaderMap,
) -> ApiResult<Json<Vec<enrollment::NativeIdentity>>> {
    Ok(Json(
        a.service.native_identities(m, a.actor(&h).await?).await?,
    ))
}
async fn native_devices(
    State(a): State<MobileApp>,
    Path(m): Path<Uuid>,
    h: HeaderMap,
) -> ApiResult<Json<Vec<enrollment::Device>>> {
    Ok(Json(a.service.native_devices(m, a.actor(&h).await?).await?))
}
async fn invite_device(
    State(a): State<MobileApp>,
    Path(m): Path<Uuid>,
    h: HeaderMap,
    Json(i): Json<enrollment::Invite>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        a.service
            .invite_device(m, a.actor(&h).await?, i.identity_id)
            .await?,
    ))
}
async fn revoke_device(
    State(a): State<MobileApp>,
    Path((m, d)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    a.service.revoke_device(m, a.actor(&h).await?, d).await?;
    Ok(Json(json!({"revoked":true})))
}
async fn enroll_device(
    State(a): State<MobileApp>,
    Json(i): Json<enrollment::Enroll>,
) -> ApiResult<Json<enrollment::Session>> {
    limit(
        &a.service.pool,
        &format!("mobile-invite:{}", token_hash(&i.code)),
    )
    .await?;
    Ok(Json(a.service.enroll_device(i).await?))
}
async fn renew_device(
    State(a): State<MobileApp>,
    Json(i): Json<enrollment::Renew>,
) -> ApiResult<Json<enrollment::Session>> {
    limit(
        &a.service.pool,
        &format!("mobile-device:{}", token_hash(&i.device_token)),
    )
    .await?;
    Ok(Json(a.service.renew_device(i).await?))
}
async fn native_asset(
    State(a): State<MobileApp>,
    Path(asset): Path<Uuid>,
    Query(q): Query<MobileQuery>,
    h: HeaderMap,
) -> ApiResult<Response> {
    let token = identity::bearer(&h).map_err(|_| Error::Unauthorized)?;
    let (key, checksum) = a
        .service
        .native_asset(token, q.platform, &q.runtime_version, asset)
        .await?;
    limit(
        &a.service.pool,
        &format!("mobile-session:{}", token_hash(token)),
    )
    .await?;
    let bytes = a
        .media
        .as_ref()
        .ok_or(Error::Storage)?
        .get(&key)
        .await
        .map_err(|_| Error::Storage)?;
    if bytes.len() > 5 * 1024 * 1024 || bytes_checksum(&bytes) != checksum {
        return Err(Error::Storage.into());
    }
    Ok((
        [
            ("content-type", "image/png"),
            ("cache-control", "private, no-store"),
            ("vary", "Authorization"),
            ("x-content-type-options", "nosniff"),
            ("x-asset-checksum", checksum.as_str()),
        ],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod studio_tests {
    use super::*;
    #[test]
    fn image_upload_decodes_and_strips_untrusted_content() {
        use image::{DynamicImage, ImageFormat};
        let mut data = std::io::Cursor::new(Vec::new());
        DynamicImage::new_rgba8(8, 6)
            .write_to(&mut data, ImageFormat::Png)
            .unwrap();
        data.get_mut()
            .extend_from_slice(b"<script>untrusted metadata</script>");
        let (clean, w, h) = prepare_image(data.get_ref()).unwrap();
        assert_eq!((w, h), (8, 6));
        assert!(!String::from_utf8_lossy(&clean).contains("script"));
        assert!(prepare_image(b"<svg onload='alert(1)' />").is_err());
        assert!(prepare_image(b"\x89PNG\r\n\x1a\ntruncated").is_err());
        assert!(prepare_image(&vec![0; 5 * 1024 * 1024 + 1]).is_err());
    }
}
