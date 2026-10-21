use super::Outcome;
use chrono::Utc;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    app_id: String,
    apns: Option<Apns>,
    fcm_service_account_file: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Apns {
    team_id: String,
    key_id: String,
    key_file: String,
    environment: String,
}
#[derive(Deserialize)]
struct ServiceAccount {
    project_id: String,
    client_email: String,
    private_key: String,
}
pub struct Provider {
    config: Config,
    apns_key: Option<EncodingKey>,
    fcm: Option<(ServiceAccount, EncodingKey)>,
    http: reqwest::Client,
    access: Mutex<Option<(String, i64)>>,
    apns_access: Mutex<Option<(String, i64)>>,
}
impl Provider {
    pub fn from_environment() -> Result<Option<Arc<Self>>, Box<dyn std::error::Error>> {
        let Ok(path) = std::env::var("ORDER_PUSH_CONFIG_FILE") else {
            return Ok(None);
        };
        let config: Config = serde_json::from_slice(
            &std::fs::read(path).map_err(|_| "Cannot read push configuration")?,
        )
        .map_err(|_| "Invalid push configuration")?;
        if config.app_id.len() > 200
            || !config.app_id.contains('.')
            || !config
                .app_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        {
            return Err("Invalid push app ID".into());
        }
        let apns_key = if let Some(a) = &config.apns {
            if !matches!(a.environment.as_str(), "sandbox" | "production")
                || a.team_id.len() != 10
                || a.key_id.len() != 10
            {
                return Err("Invalid APNs settings".into());
            }
            Some(
                EncodingKey::from_ec_pem(
                    &std::fs::read(&a.key_file).map_err(|_| "Cannot read APNs key")?,
                )
                .map_err(|_| "Invalid APNs key")?,
            )
        } else {
            None
        };
        let fcm = if let Some(path) = &config.fcm_service_account_file {
            let account: ServiceAccount = serde_json::from_slice(
                &std::fs::read(path).map_err(|_| "Cannot read FCM service account")?,
            )
            .map_err(|_| "Invalid FCM service account")?;
            if account.project_id.is_empty()
                || !account
                    .project_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || !account.client_email.ends_with(".iam.gserviceaccount.com")
            {
                return Err("Invalid FCM project".into());
            }
            let key = EncodingKey::from_rsa_pem(account.private_key.as_bytes())
                .map_err(|_| "Invalid FCM signing key")?;
            Some((account, key))
        } else {
            None
        };
        if apns_key.is_none() && fcm.is_none() {
            return Err("Configure at least one push provider".into());
        }
        let http = reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(12))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Some(Arc::new(Self {
            config,
            apns_key,
            fcm,
            http,
            access: Mutex::new(None),
            apns_access: Mutex::new(None),
        })))
    }
    #[cfg(test)]
    pub(super) fn fixture() -> Arc<Self> {
        Arc::new(Self {
            config: Config {
                app_id: "com.rocento.grocery".into(),
                apns: Some(Apns {
                    team_id: "TESTTEAM00".into(),
                    key_id: "TESTKEY000".into(),
                    key_file: String::new(),
                    environment: "sandbox".into(),
                }),
                fcm_service_account_file: None,
            },
            apns_key: Some(EncodingKey::from_secret(b"test-only-never-sends")),
            fcm: None,
            http: reqwest::Client::new(),
            access: Mutex::new(None),
            apns_access: Mutex::new(None),
        })
    }
    pub(super) fn app_id(&self) -> &str {
        &self.config.app_id
    }
    pub fn accepts(&self, app_id: &str, platform: &str) -> bool {
        self.config.app_id == app_id
            && match platform {
                "ios" => self.apns_key.is_some(),
                "android" => self.fcm.is_some(),
                _ => false,
            }
    }
    async fn fcm_access(&self) -> Option<String> {
        let mut cached = self.access.lock().await;
        let now = Utc::now().timestamp();
        if let Some((token, expires)) = &*cached {
            if *expires > now + 60 {
                return Some(token.clone());
            }
        }
        let (a, key) = self.fcm.as_ref()?;
        let claim = json!({"iss":a.client_email,"scope":"https://www.googleapis.com/auth/firebase.messaging","aud":"https://oauth2.googleapis.com/token","iat":now,"exp":now+3600});
        let assertion = jsonwebtoken::encode(&Header::new(Algorithm::RS256), &claim, key).ok()?;
        let response = self
            .http
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", &assertion),
            ])
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body: Value = response.json().await.ok()?;
        let token = body["access_token"].as_str()?.to_owned();
        let seconds = body["expires_in"].as_i64()?.clamp(60, 3600);
        *cached = Some((token.clone(), now + seconds));
        Some(token)
    }
    pub async fn send(
        &self,
        platform: &str,
        token: &str,
        event: Uuid,
        order: Uuid,
        customer: Uuid,
        locale: &str,
    ) -> Outcome {
        // No customer name, address, contents, number, or payment details on the lock screen.
        let (title, body) = if locale == "ar" {
            (
                "تحديث الطلب",
                "تم تحديث طلبك. افتح التطبيق للاطلاع على آخر حالة.",
            )
        } else {
            (
                "Order update",
                "Your order was updated. Open the app for the latest status.",
            )
        };
        let response = if platform == "ios" {
            let (Some(a), Some(key)) = (&self.config.apns, &self.apns_key) else {
                return Outcome::Failed;
            };
            let now = Utc::now().timestamp();
            let jwt = {
                let mut cached = self.apns_access.lock().await;
                if cached
                    .as_ref()
                    .is_none_or(|(_, issued)| now - issued >= 3000)
                {
                    let mut header = Header::new(Algorithm::ES256);
                    header.kid = Some(a.key_id.clone());
                    let Ok(jwt) =
                        jsonwebtoken::encode(&header, &json!({"iss":a.team_id,"iat":now}), key)
                    else {
                        return Outcome::Retry;
                    };
                    *cached = Some((jwt, now));
                }
                cached.as_ref().unwrap().0.clone()
            };
            let host = if a.environment == "sandbox" {
                "api.sandbox.push.apple.com"
            } else {
                "api.push.apple.com"
            };
            self.http.post(format!("https://{host}/3/device/{token}")).version(reqwest::Version::HTTP_2)
    .bearer_auth(jwt).header("apns-topic",&self.config.app_id).header("apns-push-type","alert").header("apns-priority","10")
    .header("apns-id",event.to_string()).header("apns-collapse-id",order.to_string()).header("apns-expiration",(Utc::now().timestamp()+3600).to_string())
    .json(&json!({"aps":{"alert":{"title":title,"body":body},"sound":"default","thread-id":order.to_string()},"order_id":order.to_string(),"event_id":event.to_string(),"customer_id":customer.to_string()})).send().await
        } else {
            let Some((a, _)) = &self.fcm else {
                return Outcome::Failed;
            };
            let Some(access) = self.fcm_access().await else {
                return Outcome::Retry;
            };
            // Data-only lets the native receiver enforce local sign-in/permission preferences.
            self.http.post(format!("https://fcm.googleapis.com/v1/projects/{}/messages:send",a.project_id)).bearer_auth(access)
    .json(&json!({"message":{"token":token,"data":{"order_id":order.to_string(),"event_id":event.to_string(),"customer_id":customer.to_string(),"title":title,"body":body},"android":{"priority":"high","ttl":"3600s","collapse_key":order.to_string(),"restricted_package_name":self.config.app_id}}})).send().await
        };
        let Ok(response) = response else {
            return Outcome::Retry;
        };
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Outcome::Delivered;
        }
        if platform == "android" && status == 401 {
            *self.access.lock().await = None;
        }
        let body: Value = response.json().await.unwrap_or(Value::Null);
        classify(platform, status, &body)
    }
}
pub fn classify(platform: &str, status: u16, body: &Value) -> Outcome {
    if platform == "ios"
        && (status == 410
            || (status == 400
                && matches!(
                    body["reason"].as_str(),
                    Some("BadDeviceToken" | "DeviceTokenNotForTopic")
                )))
    {
        return Outcome::InvalidToken;
    }
    if platform == "android"
        && body["error"]["details"]
            .as_array()
            .is_some_and(|d| d.iter().any(|v| v["errorCode"] == "UNREGISTERED"))
    {
        return Outcome::InvalidToken;
    }
    if status == 408 || status == 429 || status >= 500 || status == 401 || status == 403 {
        Outcome::Retry
    } else {
        Outcome::Failed
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_tokens_are_distinct_from_provider_outages() {
        assert_eq!(classify("ios", 410, &Value::Null), Outcome::InvalidToken);
        assert_eq!(
            classify("ios", 403, &json!({"reason":"ExpiredProviderToken"})),
            Outcome::Retry
        );
        assert_eq!(
            classify(
                "android",
                404,
                &json!({"error":{"details":[{"errorCode":"UNREGISTERED"}]}})
            ),
            Outcome::InvalidToken
        );
        assert_eq!(
            classify(
                "android",
                400,
                &json!({"error":{"status":"INVALID_ARGUMENT"}})
            ),
            Outcome::Failed
        );
        assert_eq!(classify("android", 429, &Value::Null), Outcome::Retry);
    }
}
