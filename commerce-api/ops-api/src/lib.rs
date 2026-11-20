pub mod accounts;
pub mod billing;
pub mod database;
pub mod domain;
pub mod drafts;
pub mod error;
pub mod mail;
pub mod provisioning;
pub mod provisioning_executor;
pub mod routes;
pub mod staff;

use std::sync::{Arc, Mutex};
use std::time::Instant;

use sqlx::PgPool;

use crate::accounts::Accounts;
use crate::mail::Mailer;

#[derive(Clone)]
pub struct AppState {
    pub billing: billing::BillingConfig,
    pub db: PgPool,
    pub accounts: Option<Accounts>,
    pub mailer: Option<Mailer>,
    pub local_auth_enabled: bool,
    pub local_customer_token: Option<String>,
    pub production: bool,
    pub request_window: Arc<Mutex<RequestWindow>>,
}

#[derive(Debug)]
pub struct RequestWindow {
    pub started: Instant,
    pub requests: u32,
}

impl Default for RequestWindow {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            requests: 0,
        }
    }
}
