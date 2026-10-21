//! Fixed operator-configured Android worker; owners alone can change its power state.
use super::*;
use domain_mobile::service::Access;

async fn authorize(a: &MobileApp, m: Uuid, h: &HeaderMap, control: bool) -> ApiResult<Uuid> {
    if std::env::var("MOBILE_ANDROID_PREVIEW_MERCHANT")
        .ok()
        .as_deref()
        != Some(m.to_string().as_str())
    {
        return Err(Error::NotFound.into());
    }
    let actor = if control {
        a.actor(h).await?
    } else {
        a.preview_reader(h).await?
    };
    a.service
        .authorize(
            m,
            actor,
            if control {
                Access::Publish
            } else {
                Access::Edit
            },
        )
        .await?;
    Ok(actor)
}

pub(super) async fn status(
    State(a): State<MobileApp>,
    Path(m): Path<Uuid>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    authorize(&a, m, &h, false).await?;
    super::preview_worker::Worker::configured("android", "native")?
        .instance(None)
        .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Action {
    action: String,
}

pub(super) async fn control(
    State(a): State<MobileApp>,
    Path(m): Path<Uuid>,
    h: HeaderMap,
    Json(body): Json<Action>,
) -> ApiResult<Json<Value>> {
    if !matches!(body.action.as_str(), "start" | "stop") {
        return Err(Error::Incompatible.into());
    }
    let actor = authorize(&a, m, &h, true).await?;
    // Record the request before invoking AWS; no arbitrary instance identifiers are accepted.
    sqlx::query("INSERT INTO mobile.audit_events(id,merchant_id,environment,actor_id,action,details) VALUES($1,$2,'production',$3,$4,'{}')")
        .bind(Uuid::new_v4()).bind(m).bind(actor).bind(format!("preview.ec2.{}.requested", body.action))
        .execute(&a.service.pool).await.map_err(|_| Error::Storage)?;
    super::preview_worker::Worker::configured("android", "native")?
        .instance(Some(&body.action))
        .await
}
