//! Private worker transport. Browser access always rechecks the session's owner and tenant.
use super::*;
use std::time::Duration;

pub(super) struct Worker {
    client: reqwest::Client,
    origin: String,
    token: String,
}
impl Worker {
    pub(super) async fn instance(&self, action: Option<&str>) -> ApiResult<Json<Value>> {
        let request = if let Some(action) = action {
            self.client
                .post(format!("{}/instance/{action}", self.origin))
        } else {
            self.client.get(format!("{}/instance", self.origin))
        };
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| Error::Storage)?;
        if response.status() == StatusCode::CONFLICT {
            return Err(Error::Conflict.into());
        }
        if !response.status().is_success() {
            return Err(Error::Storage.into());
        }
        Ok(Json(response.json().await.map_err(|_| Error::Storage)?))
    }
    pub(super) fn configured(platform: &str, implementation: &str) -> ApiResult<Self> {
        let prefix = match (platform, implementation) {
            ("ios", "native") => "MOBILE_PREVIEW",
            ("android", "native") => "MOBILE_ANDROID_PREVIEW",
            ("ios", "react-native") => "MOBILE_RN_IOS_PREVIEW",
            ("android", "react-native") => "MOBILE_RN_ANDROID_PREVIEW",
            _ => return Err(Error::Storage.into()),
        };
        let origin = std::env::var(format!("{prefix}_WORKER_URL")).map_err(|_| Error::Storage)?;
        let url = reqwest::Url::parse(&origin).map_err(|_| Error::Storage)?;
        let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(Error::Storage.into());
        }
        let token = std::env::var(format!("{prefix}_WORKER_TOKEN")).map_err(|_| Error::Storage)?;
        if token.len() < 32 {
            return Err(Error::Storage.into());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::Storage)?;
        Ok(Self {
            client,
            origin: origin.trim_end_matches('/').into(),
            token,
        })
    }
    fn request(&self, method: reqwest::Method, id: Uuid) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}/sessions/{id}", self.origin))
            .bearer_auth(&self.token)
    }
    pub(super) async fn stop(&self, id: Uuid) {
        let _ = self.request(reqwest::Method::DELETE, id).send().await;
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkerScope {
    environment: Environment,
    #[serde(default = "ios_platform")]
    platform: Platform,
    #[serde(default = "native_implementation")]
    implementation: String,
}
fn native_implementation() -> String {
    "native".into()
}
fn ios_platform() -> Platform {
    Platform::Ios
}

pub(super) async fn start(
    State(a): State<MobileApp>,
    Path(m): Path<Uuid>,
    Query(q): Query<WorkerScope>,
    h: HeaderMap,
) -> ApiResult<Json<Value>> {
    let actor = a.actor(&h).await?;
    let worker = Worker::configured(q.platform.as_str(), &q.implementation)?;
    let session = a
        .service
        .start_worker_preview(m, q.environment, actor, q.platform, &q.implementation)
        .await?;
    let id = Uuid::parse_str(session["id"].as_str().ok_or(Error::Storage)?)
        .map_err(|_| Error::Storage)?;
    let mut payload = json!({
        "merchantId": m, "environment": q.environment.as_str(),
        "code": session["code"], "expiresAt": session["expiresAt"]
    });
    // Android shares one worker/capacity pool; preserve the existing iOS contract.
    if q.platform == Platform::Android && q.implementation == "react-native" {
        payload["implementation"] = json!(q.implementation);
    }
    let result = worker
        .request(reqwest::Method::POST, id)
        .json(&payload)
        .send()
        .await;
    if !matches!(result, Ok(ref r) if r.status().is_success()) {
        a.service.stop_preview(m, actor, id).await?;
        worker.stop(id).await;
        return Err(
            if matches!(result, Ok(ref r) if r.status() == StatusCode::CONFLICT) {
                Error::Conflict
            } else {
                Error::Storage
            }
            .into(),
        );
    }
    // The native bearer capability stays between the gateway and the worker.
    Ok(Json(json!({"id": id, "expiresAt": session["expiresAt"]})))
}
pub(super) async fn frame(
    State(a): State<MobileApp>,
    Path((m, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
) -> ApiResult<Response> {
    let status = a
        .service
        .preview_status(m, a.preview_reader(&h).await?, id)
        .await?;
    if status.revoked_at.is_some() || status.expires_at <= chrono::Utc::now() {
        return Err(Error::Unauthorized.into());
    }
    let worker = Worker::configured(&status.platform, &status.implementation)?;
    let mut response = worker
        .request(reqwest::Method::GET, id)
        .send()
        .await
        .map_err(|_| Error::Storage)?;
    if response.status() == reqwest::StatusCode::ACCEPTED {
        return Ok((
            StatusCode::ACCEPTED,
            [("cache-control", "private, no-store")],
        )
            .into_response());
    }
    if !response.status().is_success() {
        return Err(Error::Storage.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Storage)? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err(Error::Storage.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") && !bytes.starts_with(b"\xff\xd8") {
        return Err(Error::Storage.into());
    }
    Ok((
        [
            (
                "content-type",
                if bytes.starts_with(b"\xff\xd8") {
                    "image/jpeg"
                } else {
                    "image/png"
                },
            ),
            ("cache-control", "private, no-store"),
            ("x-content-type-options", "nosniff"),
            ("vary", "Cookie"),
        ],
        bytes,
    )
        .into_response())
}

/// Continuous capture; authorization is rechecked during the response, not just at connect.
pub(super) async fn video(
    State(a): State<MobileApp>,
    Path((m, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
) -> ApiResult<Response> {
    let actor = a.preview_reader(&h).await?;
    let status = active(&a, m, actor, id).await?;
    let worker = Worker::configured(&status.platform, &status.implementation)?;
    let response = worker
        .client
        .get(format!("{}/sessions/{id}/video", worker.origin))
        .bearer_auth(&worker.token)
        .timeout(Duration::from_secs(1800))
        .send()
        .await
        .map_err(|_| Error::Storage)?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(Error::Storage.into());
    }
    let stream = futures_util::stream::unfold(
        (response, a, h, tokio::time::Instant::now()),
        move |(mut response, a, h, mut checked)| async move {
            if checked.elapsed() >= Duration::from_secs(2) {
                let authenticated = a
                    .identity
                    .admins
                    .authenticate(identity::cookie(&h, "admin_session"))
                    .await;
                if !matches!(authenticated, Ok(ref who) if who.user.id == actor)
                    || active(&a, m, actor, id).await.is_err()
                {
                    return None;
                }
                checked = tokio::time::Instant::now();
            }
            match tokio::time::timeout(Duration::from_secs(5), response.chunk()).await {
                Ok(Ok(Some(bytes))) if bytes.len() <= 4 * 1024 * 1024 => {
                    Some((Ok::<_, std::io::Error>(bytes), (response, a, h, checked)))
                }
                _ => None,
            }
        },
    );
    Ok((
        [
            ("content-type", "application/x-rocento-mjpeg"),
            ("cache-control", "private, no-store"),
            ("x-accel-buffering", "no"),
            ("x-content-type-options", "nosniff"),
            ("vary", "Cookie"),
        ],
        axum::body::Body::from_stream(stream),
    )
        .into_response())
}
async fn active(
    a: &MobileApp,
    m: Uuid,
    actor: Uuid,
    id: Uuid,
) -> ApiResult<domain_mobile::preview::PreviewStatus> {
    let status = a.service.preview_status(m, actor, id).await?;
    if status.revoked_at.is_some() || status.expires_at <= chrono::Utc::now() {
        return Err(Error::Unauthorized.into());
    }
    Ok(status)
}
pub(super) async fn input(
    State(a): State<MobileApp>,
    Path((m, id)): Path<(Uuid, Uuid)>,
    h: HeaderMap,
    Json(input): Json<Value>,
) -> ApiResult<Response> {
    // Input has a separate bounded budget from editor/status requests.
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&h, "admin_session"))
        .await
        .map_err(|_| Error::Unauthorized)?;
    let status = active(&a, m, who.user.id, id).await?;
    infra_auth::rate_limit(
        &a.service.pool,
        &format!("mobile-preview-input:{}", who.user.id),
        3000,
    )
    .await
    .map_err(|e| {
        if matches!(e, infra_auth::Error::RateLimited) {
            Error::RateLimited
        } else {
            Error::Storage
        }
    })?;
    if !valid_input(&input) {
        return Ok(StatusCode::BAD_REQUEST.into_response());
    }
    let worker = Worker::configured(&status.platform, &status.implementation)?;
    let response = worker
        .client
        .post(format!("{}/sessions/{id}/input", worker.origin))
        .bearer_auth(&worker.token)
        .json(&input)
        .send()
        .await
        .map_err(|_| Error::Storage)?;
    Ok(match response.status().as_u16() {
        204 => StatusCode::NO_CONTENT,
        400 => StatusCode::BAD_REQUEST,
        409 => StatusCode::CONFLICT,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
    .into_response())
}
fn valid_input(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    if !v["sequence"]
        .as_u64()
        .is_some_and(|s| s > 0 && s < (1_u64 << 53))
    {
        return false;
    }
    let coordinate = |key: &str| {
        v[key]
            .as_f64()
            .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
    };
    match v["kind"].as_str() {
        Some("tap") => o.len() == 4 && coordinate("x") && coordinate("y"),
        Some("swipe") => {
            o.len() == 7
                && coordinate("x")
                && coordinate("y")
                && coordinate("endX")
                && coordinate("endY")
                && v["duration"]
                    .as_f64()
                    .is_some_and(|n| (0.05..=1.5).contains(&n))
        }
        Some("text") => {
            o.len() == 3
                && v["text"].as_str().is_some_and(|s| {
                    !s.is_empty() && s.len() <= 128 && s.bytes().all(|c| (32..=126).contains(&c))
                })
        }
        Some("key") => {
            o.len() == 3
                && matches!(
                    v["key"].as_str(),
                    Some(
                        "Enter"
                            | "Backspace"
                            | "Tab"
                            | "Escape"
                            | "ArrowRight"
                            | "ArrowLeft"
                            | "ArrowDown"
                            | "ArrowUp"
                            | "Delete"
                    )
                )
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_is_bounded_and_cannot_select_commands_or_targets() {
        assert!(valid_input(
            &json!({"sequence":1,"kind":"tap","x":0.5,"y":0.5})
        ));
        assert!(valid_input(
            &json!({"sequence":2,"kind":"text","text":"milk"})
        ));
        for value in [
            json!({"sequence":1,"kind":"tap","x":-0.1,"y":0.5}),
            json!({"sequence":1,"kind":"tap","x":0.5,"y":0.5,"device":"other"}),
            json!({"sequence":0,"kind":"text","text":"milk"}),
            json!({"sequence":1,"kind":"text","text":"\n"}),
            json!({"sequence":1,"kind":"key","key":"Shell"}),
            json!({"sequence":1,"kind":"text","text":"x".repeat(129)}),
        ] {
            assert!(!valid_input(&value));
        }
    }
}
