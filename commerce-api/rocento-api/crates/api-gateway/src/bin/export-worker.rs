//! Run independently of the HTTP gateway. One job per process, two DB connections.
use api_gateway::{
    exports::{self, Job},
    grids,
};
use serde_json::Value;
use sqlx::PgPool;
use std::{
    fs::File,
    io::{Read, Write},
    path::PathBuf,
};
use zip::{write::SimpleFileOptions, ZipWriter};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const SHEET_ROWS: u64 = 1_048_575; // Excel limit minus the repeated header.
const DEFAULT_MAX_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const HEALTH_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(120);
fn health_path() -> PathBuf {
    std::env::temp_dir().join("commerce-export-worker.health")
}
fn heartbeat() -> std::io::Result<()> {
    std::fs::write(health_path(), b"ready")
}
fn fresh_heartbeat(path: &std::path::Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age <= HEALTH_MAX_AGE)
}
async fn health() -> Result<()> {
    if !fresh_heartbeat(&health_path()) {
        return Err("Export worker has no recent successful queue or job progress".into());
    }
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(2))
        .connect(&std::env::var("DATABASE_URL")?)
        .await?;
    // Read-only, bounded access check against the worker's actual queue.
    sqlx::query("SELECT id FROM admin_iam.export_jobs LIMIT 1")
        .fetch_optional(&pool)
        .await?;
    Ok(())
}

fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(v) => v.clone(),
        v => v.to_string(),
    }
}
fn csv_cell(v: &Value) -> String {
    domain_admin_operations::csv_cells::escape(&text(v))
}
fn xml(s: &str) -> String {
    s.chars()
        .filter(|c| {
            matches!(c, '\t' | '\n' | '\r') || (*c >= ' ' && *c != '\u{fffe}' && *c != '\u{ffff}')
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn row(w: &mut impl Write, cells: impl IntoIterator<Item = String>) -> Result<()> {
    w.write_all(b"<row>")?;
    for cell in cells {
        // XLSX inline strings avoid formula execution and an unbounded shared-string table.
        if cell.chars().count() > 32767 {
            return Err("A cell exceeds Excel's 32,767 character limit; use CSV".into());
        }
        write!(
            w,
            "<c t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
            xml(&cell)
        )?;
    }
    w.write_all(b"</row>")?;
    Ok(())
}
fn sheet(w: &mut ZipWriter<File>, n: u64, columns: &[String]) -> Result<()> {
    w.start_file(
        format!("xl/worksheets/sheet{n}.xml"),
        SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .large_file(true),
    )?;
    w.write_all(b"<?xml version=\"1.0\" encoding=\"UTF-8\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>")?;
    row(w, columns.iter().cloned())
}
fn finish(w: &mut ZipWriter<File>, sheets: u64) -> Result<()> {
    w.write_all(b"</sheetData></worksheet>")?;
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    w.start_file("[Content_Types].xml", opts)?;
    write!(w,"<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>")?;
    for n in 1..=sheets {
        write!(w,"<Override PartName=\"/xl/worksheets/sheet{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>")?;
    }
    w.write_all(b"</Types>")?;
    w.start_file("_rels/.rels", opts)?;
    w.write_all(b"<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>")?;
    w.start_file("xl/workbook.xml", opts)?;
    w.write_all(b"<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>")?;
    for n in 1..=sheets {
        write!(
            w,
            "<sheet name=\"Export {n}\" sheetId=\"{n}\" r:id=\"rId{n}\"/>"
        )?;
    }
    w.write_all(b"</sheets></workbook>")?;
    w.start_file("xl/_rels/workbook.xml.rels", opts)?;
    w.write_all(
        b"<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    )?;
    for n in 1..=sheets {
        write!(w,"<Relationship Id=\"rId{n}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{n}.xml\"/>")?;
    }
    w.write_all(b"</Relationships>")?;
    Ok(())
}
async fn progress(pool: &PgPool, j: &Job, rows: i64) -> Result<()> {
    let updated=sqlx::query("UPDATE admin_iam.export_jobs SET rows_processed=$2,heartbeat_at=now() WHERE id=$1 AND status='running' AND expires_at>now() AND EXISTS(SELECT 1 FROM admin_iam.admin_users u JOIN admin_iam.roles r ON r.id=u.role_id WHERE u.id=owner_id AND u.active AND ('*'=ANY(r.permissions) OR ($3=ANY(r.permissions) AND $4=ANY(r.permissions))))")
 .bind(j.id).bind(rows).bind(exports::permission(&j.grid)?).bind(grids::definition(&j.grid)?.permission).execute(pool).await?;
    if updated.rows_affected() != 1 {
        return Err("Export cancelled, expired, or permission revoked".into());
    }
    heartbeat()?;
    Ok(())
}
async fn run(pool: &PgPool, j: &Job, path: &PathBuf) -> Result<()> {
    let max_bytes = std::env::var("EXPORT_MAX_BYTES")
        .ok()
        .map(|v| v.parse::<u64>())
        .transpose()?
        .unwrap_or(DEFAULT_MAX_BYTES);
    if max_bytes == 0 {
        return Err("EXPORT_MAX_BYTES must be positive".into());
    }
    let mut r: grids::Request = serde_json::from_value(j.request.clone())?;
    let columns: Vec<String> = serde_json::from_value(j.columns.clone())?;
    exports::validate(&exports::Input {
        grid: j.grid.clone(),
        request: r.clone(),
        columns: columns.clone(),
        format: j.format.clone(),
    })?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    let mut csv = if j.format == "csv" {
        Some(csv::Writer::from_writer(file.try_clone()?))
    } else {
        None
    };
    let mut xlsx = if j.format == "xlsx" {
        Some(ZipWriter::new(file))
    } else {
        None
    };
    let mut sheets = 1;
    let mut count = 0i64;
    if let Some(w) = &mut csv {
        w.write_record(&columns)?;
    }
    if let Some(w) = &mut xlsx {
        sheet(w, 1, &columns)?;
    }
    // Stable snapshot is owned solely by this worker; no application/advisory locks.
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='60s'")
        .execute(&mut *tx)
        .await?;
    loop {
        progress(pool, j, count).await?;
        let p = grids::export_page(&mut tx, &j.grid, &r, j.tenant_id).await?;
        for item in p.items {
            if let Some(w) = &mut csv {
                w.write_record(columns.iter().map(|c| csv_cell(&item[c])))?;
            }
            if let Some(w) = &mut xlsx {
                if count > 0 && (count as u64).is_multiple_of(SHEET_ROWS) {
                    w.write_all(b"</sheetData></worksheet>")?;
                    sheets += 1;
                    sheet(w, sheets, &columns)?;
                }
                row(w, columns.iter().map(|c| text(&item[c])))?;
            }
            count += 1;
        }
        if std::fs::metadata(path)?.len() > max_bytes {
            return Err(format!(
                "Export exceeds {max_bytes} bytes; narrow filters or raise EXPORT_MAX_BYTES"
            )
            .into());
        }
        r.cursor = p.next_cursor;
        if r.cursor.is_none() {
            break;
        }
    }
    tx.commit().await?;
    if let Some(mut w) = csv {
        w.flush()?;
    }
    if let Some(mut w) = xlsx {
        finish(&mut w, sheets)?;
        w.finish()?;
    }
    progress(pool, j, count).await?;
    let mut file = File::open(path)?;
    let bytes = file.metadata()?.len();
    if bytes > max_bytes {
        return Err(format!(
            "Export exceeds {max_bytes} bytes; narrow filters or raise EXPORT_MAX_BYTES"
        )
        .into());
    }
    let mut buffer = vec![0; 1024 * 1024];
    let mut sequence = 0i32;
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        progress(pool, j, count).await?;
        sqlx::query("INSERT INTO admin_iam.export_chunks(job_id,sequence,data) VALUES($1,$2,$3)")
            .bind(j.id)
            .bind(sequence)
            .bind(&buffer[..n])
            .execute(pool)
            .await?;
        sequence += 1;
    }
    sqlx::query("UPDATE admin_iam.export_jobs SET status='completed',rows_processed=$2,bytes_written=$3,heartbeat_at=now() WHERE id=$1 AND status='running'").bind(j.id).bind(count).bind(bytes as i64).execute(pool).await?;
    Ok(())
}
// A crashed process can leave a disk spool; prune only recognised, inactive job files.
async fn prune_spools(pool: &PgPool) -> Result<()> {
    for entry in std::fs::read_dir(std::env::temp_dir())? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(id) = name
            .strip_prefix("commerce-export-")
            .and_then(|v| v.strip_suffix(".tmp"))
            .and_then(|v| v.parse::<uuid::Uuid>().ok())
        else {
            continue;
        };
        let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM admin_iam.export_jobs WHERE id=$1 AND status='running' AND heartbeat_at>now()-interval '10 minutes' AND expires_at>now())").bind(id).fetch_one(pool).await?;
        if !active {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}
#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args().skip(1).any(|arg| arg == "--health") {
        return tokio::time::timeout(std::time::Duration::from_secs(4), health()).await?;
    }
    match std::fs::remove_file(health_path()) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&std::env::var("DATABASE_URL")?)
        .await?;
    let mut ticks = 0u64;
    loop {
        if ticks.is_multiple_of(30) {
            if let Err(e) = prune_spools(&pool).await {
                eprintln!("Spool cleanup: {e}");
            }
        }
        ticks += 1;
        match exports::claim(&pool).await {
            Ok(Some(j)) => {
                heartbeat()?;
                let path = std::env::temp_dir().join(format!("commerce-export-{}.tmp", j.id));
                if let Err(e) = run(&pool, &j, &path).await {
                    eprintln!("Export {} failed: {e}", j.id);
                    sqlx::query("UPDATE admin_iam.export_jobs SET status='failed',error='Export failed. Check worker logs or narrow the filters and retry.' WHERE id=$1 AND status='running'").bind(j.id).execute(&pool).await?;
                    sqlx::query("DELETE FROM admin_iam.export_chunks WHERE job_id=$1")
                        .bind(j.id)
                        .execute(&pool)
                        .await?;
                }
                let _ = std::fs::remove_file(path);
            }
            Ok(None) => {
                heartbeat()?;
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(e) => {
                eprintln!("Export queue: {e}");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn heartbeat_requires_recent_worker_progress() {
        let path = std::env::temp_dir().join(format!("export-health-{}", uuid::Uuid::new_v4()));
        assert!(!fresh_heartbeat(&path));
        std::fs::write(&path, b"ready").unwrap();
        assert!(fresh_heartbeat(&path));
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(
            std::time::SystemTime::now() - HEALTH_MAX_AGE - std::time::Duration::from_secs(1),
        ))
        .unwrap();
        assert!(!fresh_heartbeat(&path));
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn formula_and_xml_safety() {
        assert_eq!(csv_cell(&Value::String(" =1+1".into())), "' =1+1");
        assert_eq!(xml("<&\u{0001}"), "&lt;&amp;");
    }
    #[test]
    fn workbook_is_valid_zip() {
        let path = std::env::temp_dir().join(format!("xlsx-test-{}", uuid::Uuid::new_v4()));
        let mut w = ZipWriter::new(File::create(&path).unwrap());
        sheet(&mut w, 1, &["sku".into()]).unwrap();
        row(&mut w, ["=1+1".into()]).unwrap();
        finish(&mut w, 1).unwrap();
        w.finish().unwrap();
        let mut z = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let mut s = String::new();
        z.by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut s)
            .unwrap();
        assert!(s.contains("inlineStr"));
        assert!(!s.contains("<f>"));
        std::fs::remove_file(path).unwrap();
    }
    #[sqlx::test(migrations = "../../migrations")]
    async fn background_csv_and_excel_preserve_filters_columns_and_progress(pool: PgPool) {
        let owner = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'export@test.invalid','worker','unused',$2)").bind(owner).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO catalog.categories(id,name,slug) SELECT md5(n::text)::uuid,'=formula',n::text FROM generate_series(1,601) n").execute(&pool).await.unwrap();
        for format in ["csv", "xlsx"] {
            let id = uuid::Uuid::new_v4();
            sqlx::query("INSERT INTO admin_iam.export_jobs(id,owner_id,grid,request,columns,format) VALUES($1,$2,'categories',$3,$4,$5)").bind(id).bind(owner).bind(serde_json::json!({"q":"=formula","sort":"name","limit":200,"descending":true})).bind(serde_json::json!(["slug","name"])).bind(format).execute(&pool).await.unwrap();
            let j = exports::claim(&pool).await.unwrap().unwrap();
            let path = std::env::temp_dir().join(format!("export-test-{id}"));
            run(&pool, &j, &path).await.unwrap();
            let (status, count): (String, i64) = sqlx::query_as(
                "SELECT status,rows_processed FROM admin_iam.export_jobs WHERE id=$1",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(status, "completed");
            assert_eq!(count, 601);
            let chunks: Vec<Vec<u8>> = sqlx::query_scalar(
                "SELECT data FROM admin_iam.export_chunks WHERE job_id=$1 ORDER BY sequence",
            )
            .bind(id)
            .fetch_all(&pool)
            .await
            .unwrap();
            assert!(chunks.iter().all(|c| c.len() <= 1024 * 1024));
            assert_eq!(chunks.concat(), std::fs::read(&path).unwrap());
            if format == "csv" {
                let mut reader = csv::Reader::from_path(&path).unwrap();
                assert_eq!(
                    reader.headers().unwrap(),
                    &csv::StringRecord::from(vec!["slug", "name"])
                );
                let rows: Vec<_> = reader.records().map(|v| v.unwrap()).collect();
                assert_eq!(rows.len(), 601);
                assert_eq!(&rows[0][1], "'=formula");
            }
            std::fs::remove_file(path).unwrap();
        }
    }
}
