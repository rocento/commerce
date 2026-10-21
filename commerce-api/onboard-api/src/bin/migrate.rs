use std::{
    env,
    error::Error,
    fs,
    io,
    path::PathBuf,
};

use sqlx::{postgres::PgPoolOptions, raw_sql, Postgres, Transaction};

type MigrationResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Migration failed. Check database connectivity and migration SQL: {error}");
        std::process::exit(1);
    }
}

async fn run() -> MigrationResult<()> {
    let _ = dotenvy::dotenv();
    let database_url = env::var("DATABASE_URL")?;
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await?;

    let mut transaction = pool.begin().await?;
    let applied = match apply_migrations(&mut transaction).await {
        Ok(applied) => applied,
        Err(error) => {
            let _ = transaction.rollback().await;
            return Err(error);
        }
    };
    transaction.commit().await?;

    for name in applied {
        println!("Applied {name}");
    }
    Ok(())
}

async fn apply_migrations(
    transaction: &mut Transaction<'_, Postgres>,
) -> MigrationResult<Vec<String>> {
    sqlx::query("SELECT pg_advisory_xact_lock(972421)")
        .execute(&mut **transaction)
        .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    )
    .execute(&mut **transaction)
    .await?;

    let mut migrations = fs::read_dir("database/migrations")?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<PathBuf>, io::Error>>()?;
    migrations.retain(|path| path.extension().and_then(|ext| ext.to_str()) == Some("sql"));
    migrations.sort();

    let mut applied = Vec::new();
    for path in migrations {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid migration filename"))?
            .to_owned();
        let already_applied: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1)",
        )
        .bind(&name)
        .fetch_one(&mut **transaction)
        .await?;
        if already_applied {
            continue;
        }

        let sql = fs::read_to_string(path)?;
        raw_sql(&sql).execute(&mut **transaction).await?;
        sqlx::query("INSERT INTO schema_migrations(name) VALUES($1)")
            .bind(&name)
            .execute(&mut **transaction)
            .await?;
        applied.push(name);
    }

    Ok(applied)
}
