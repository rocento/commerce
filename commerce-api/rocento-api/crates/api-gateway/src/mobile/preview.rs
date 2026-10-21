//! Draft transport is independent of simulator hosting; no executable code or frames.
use super::*;
use domain_mobile::preview::{PreviewAck, PreviewStatus};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PreviewQuery {
    merchant_id: Uuid,
    environment: Environment,
    runtime_version: String,
}
pub(super) async fn start(
    State(a): State<MobileApp>,
    Path(m): Path<Uuid>,
    Query(q): Query<Scope>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        a.service
            .start_preview(m, q.environment, a.actor(&h).await?)
            .await?,
    ))
}
pub(super) async fn status(
    State(a): State<MobileApp>,
    Path((m, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
) -> ApiResult<Json<PreviewStatus>> {
    Ok(Json(
        a.service
            .preview_status(m, a.preview_reader(&h).await?, id)
            .await?,
    ))
}
pub(super) async fn stop(
    State(a): State<MobileApp>,
    Path((m, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    let actor = a.actor(&h).await?;
    let status = a.service.preview_status(m, actor, id).await?;
    a.service.stop_preview(m, actor, id).await?;
    if let Ok(worker) =
        super::preview_worker::Worker::configured(&status.platform, &status.implementation)
    {
        worker.stop(id).await;
    }
    Ok(Json(json!({"revoked":true})))
}
async fn token<'a>(a: &MobileApp, h: &'a HeaderMap, bucket: &str) -> ApiResult<&'a str> {
    let token = identity::bearer(h).map_err(|_| Error::Unauthorized)?;
    limit(
        &a.service.pool,
        &format!("mobile-preview:{bucket}:{}", token_hash(token)),
    )
    .await?;
    Ok(token)
}
pub(super) async fn snapshot(
    State(a): State<MobileApp>,
    Path(id): Path<Uuid>,
    Query(q): Query<PreviewQuery>,
    h: HeaderMap,
) -> ApiResult<Response> {
    let draft = a
        .service
        .preview_snapshot(
            id,
            token(&a, &h, "snapshot").await?,
            q.merchant_id,
            q.environment,
            &q.runtime_version,
        )
        .await?;
    let checksum = checksum(&draft.config);
    let revision = draft.revision.to_string();
    Ok((
        [
            ("content-type", "application/json"),
            ("cache-control", "private, no-store"),
            ("vary", "Authorization"),
            ("x-preview-session", id.to_string().as_str()),
            ("x-preview-revision", revision.as_str()),
            ("x-config-checksum", checksum.as_str()),
        ],
        serde_json::to_vec(&draft.config).map_err(|_| Error::Storage)?,
    )
        .into_response())
}
pub(super) async fn ack(
    State(a): State<MobileApp>,
    Path(id): Path<Uuid>,
    Query(q): Query<PreviewQuery>,
    h: HeaderMap,
    Json(input): Json<PreviewAck>,
) -> ApiResult<Json<Value>> {
    a.service
        .acknowledge_preview(
            id,
            token(&a, &h, "ack").await?,
            q.merchant_id,
            q.environment,
            input,
        )
        .await?;
    Ok(Json(json!({"applied":true})))
}
pub(super) async fn asset(
    State(a): State<MobileApp>,
    Path((id, asset)): Path<(Uuid, Uuid)>,
    Query(q): Query<PreviewQuery>,
    h: HeaderMap,
) -> ApiResult<Response> {
    // A 2-second poll fetches up to 30 section images and one logo. Bound
    // each asset independently and also bound the total per capability.
    let capability = token(&a, &h, &format!("asset:{asset}")).await?;
    infra_auth::rate_limit(
        &a.service.pool,
        &format!("mobile-preview:assets:{}", token_hash(capability)),
        31 * 600,
    )
    .await
    .map_err(|e| {
        MobileError(match e {
            infra_auth::Error::RateLimited => Error::RateLimited,
            _ => Error::Storage,
        })
    })?;
    let (key, checksum) = a
        .service
        .preview_asset(id, capability, q.merchant_id, q.environment, asset)
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
