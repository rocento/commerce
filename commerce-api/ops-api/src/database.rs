use std::{env, time::Duration};

use sqlx::{postgres::PgPoolOptions, PgPool};

pub fn connect() -> Result<PgPool, sqlx::Error> {
    let url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://rocento:local-only@127.0.0.1:5439/rocento".to_owned());
    PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(2))
        .connect_lazy(&url)
}
