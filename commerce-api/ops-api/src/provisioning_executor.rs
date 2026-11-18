//! Privileged host integration boundary. Never run customer-supplied commands.
//! The executor must be installed and reviewed separately from application uploads.
use crate::provisioning::{Evidence, Executor, Failure, Job};
use std::{path::Path, process::Stdio};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const EXECUTOR_PATH: &str = "/usr/local/lib/rocento/onboarding-executor";
pub struct HostExecutor;

#[cfg(unix)]
fn trusted(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    path.ancestors().all(|part| {
        std::fs::symlink_metadata(part).is_ok_and(|m| {
            !m.file_type().is_symlink()
                && m.uid() == 0
                && m.mode() & 0o022 == 0
                && (part != path || (m.is_file() && m.mode() & 0o111 != 0))
        })
    })
}
#[cfg(not(unix))]
fn trusted(_: &Path) -> bool {
    false
}

impl Executor for HostExecutor {
    async fn execute(&self, job: &Job) -> Result<Evidence, Failure> {
        self.invoke(job, "execute").await
    }
    async fn reconcile(&self, job: &Job) -> Result<Evidence, Failure> {
        self.invoke(job, "reconcile").await
    }
}

impl HostExecutor {
    async fn invoke(&self, job: &Job, operation: &str) -> Result<Evidence, Failure> {
        let path = Path::new(EXECUTOR_PATH);
        if !path.exists() {
            return Err(Failure::Blocked("EXECUTOR_NOT_INSTALLED"));
        }
        if !trusted(path) {
            return Err(Failure::Review("EXECUTOR_NOT_TRUSTED"));
        }
        let input = serde_json::to_vec(&serde_json::json!({
            "schemaVersion":2,"operation":operation,"idempotencyKey":format!("{}:{}",job.id,job.step),"job":job
        }))
        .map_err(|_| Failure::Review("EXECUTOR_INPUT_INVALID"))?;
        let mut child = tokio::process::Command::new(path)
            .env_clear()
            .env(
                "PATH",
                "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            )
            .current_dir("/")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| Failure::Review("EXECUTOR_START_FAILED"))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or(Failure::Review("EXECUTOR_START_FAILED"))?;
        stdin
            .write_all(&input)
            .await
            .map_err(|_| Failure::Review("EXECUTOR_IO_FAILED"))?;
        drop(stdin);
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .ok_or(Failure::Review("EXECUTOR_IO_FAILED"))?
            .take(65537)
            .read_to_end(&mut output)
            .await
            .map_err(|_| Failure::Review("EXECUTOR_IO_FAILED"))?;
        if output.len() > 65536 {
            return Err(Failure::Review("EXECUTOR_OUTPUT_TOO_LARGE"));
        }
        let status = child
            .wait()
            .await
            .map_err(|_| Failure::Review("EXECUTOR_IO_FAILED"))?;
        match status.code() {
            Some(0) => serde_json::from_slice(&output)
                .map_err(|_| Failure::Review("EXECUTOR_OUTPUT_INVALID")),
            // Contract: 75 guarantees the step can safely be retried with the
            // same idempotency key; ambiguous failures require manual review.
            Some(75) => Err(Failure::Retry("EXECUTOR_RETRYABLE")),
            Some(78) => {
                let reason = serde_json::from_slice::<serde_json::Value>(&output).ok();
                let code = match reason.as_ref().and_then(|v| v["blocker"].as_str()) {
                    Some("HOSTING_PROVIDER_REQUIRED") => "HOSTING_PROVIDER_REQUIRED",
                    Some("FLEET_NOT_CONFIGURED") => "FLEET_NOT_CONFIGURED",
                    Some("FLEET_HOST_LIMIT") => "FLEET_HOST_LIMIT",
                    Some("FLEET_HOST_PREPARING") => "FLEET_HOST_PREPARING",
                    Some("HOST_EXECUTION_BUSY") => "HOST_EXECUTION_BUSY",
                    Some("CAPACITY_REQUIRED") => "CAPACITY_REQUIRED",
                    Some("FLEET_HOST_REQUIRES_REVIEW") => "FLEET_HOST_REQUIRES_REVIEW",
                    _ => "RELEASE_AUTHORIZATION_REQUIRED",
                };
                Err(Failure::Blocked(code))
            }
            _ => Err(Failure::Review("EXECUTOR_FAILED")),
        }
    }
}
