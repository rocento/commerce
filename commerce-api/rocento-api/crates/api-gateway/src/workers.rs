//! Detect unexpected worker exits; dependency retries remain owned by each worker.
use std::{
    collections::HashMap,
    fmt,
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::task::{Id, JoinSet};

#[derive(Clone, Default)]
pub struct Health(Arc<HealthInner>);

#[derive(Default)]
struct HealthInner {
    registered: AtomicUsize,
    failed: AtomicBool,
    stopping: AtomicBool,
}

impl Health {
    pub fn available(&self) -> bool {
        !self.0.failed.load(Ordering::Acquire) && !self.0.stopping.load(Ordering::Acquire)
    }

    /// Task health alone does not establish availability of a worker's dependencies.
    pub fn status(&self) -> &'static str {
        if !self.available() {
            "unavailable"
        } else if self.0.registered.load(Ordering::Acquire) == 0 {
            "not_configured"
        } else {
            "running"
        }
    }
}

struct ExitGuard {
    health: Arc<HealthInner>,
}

impl Drop for ExitGuard {
    fn drop(&mut self) {
        if !self.health.stopping.load(Ordering::Acquire) {
            self.health.failed.store(true, Ordering::Release);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum FailureReason {
    Returned,
    Panicked,
    Cancelled,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Failure {
    pub name: &'static str,
    pub reason: FailureReason,
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "background worker {} failed: {:?}",
            self.name, self.reason
        )
    }
}

impl std::error::Error for Failure {}

#[derive(Default)]
pub struct Supervisor {
    tasks: JoinSet<()>,
    names: HashMap<Id, &'static str>,
    health: Health,
}

impl Supervisor {
    pub fn health(&self) -> Health {
        self.health.clone()
    }

    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    pub fn spawn(&mut self, name: &'static str, worker: impl Future<Output = ()> + Send + 'static) {
        self.health.0.registered.fetch_add(1, Ordering::Release);
        // Capture before spawning so even cancellation before the first poll is detected.
        let guard = ExitGuard {
            health: self.health.0.clone(),
        };
        let handle = self.tasks.spawn(async move {
            let _guard = guard;
            worker.await;
        });
        self.names.insert(handle.id(), name);
    }

    pub async fn next_failure(&mut self) -> Option<Failure> {
        let (id, reason) = match self.tasks.join_next_with_id().await? {
            Ok((id, ())) => (id, FailureReason::Returned),
            Err(error) => (
                error.id(),
                if error.is_panic() {
                    FailureReason::Panicked
                } else {
                    FailureReason::Cancelled
                },
            ),
        };
        self.health.0.failed.store(true, Ordering::Release);
        Some(Failure {
            name: self.names.remove(&id).unwrap_or("unknown"),
            reason,
        })
    }

    pub fn begin_shutdown(&self) {
        self.health.0.stopping.store(true, Ordering::Release);
    }

    pub async fn shutdown(&mut self) {
        self.begin_shutdown();
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        self.names.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn normal_exit_reports_name_and_marks_health_failed() {
        let mut workers = Supervisor::default();
        let health = workers.health();
        workers.spawn("outbox", async {});
        assert_eq!(
            workers.next_failure().await,
            Some(Failure {
                name: "outbox",
                reason: FailureReason::Returned
            })
        );
        assert!(!health.available());
    }

    #[tokio::test]
    async fn panic_reports_name_and_marks_health_failed() {
        let mut workers = Supervisor::default();
        let health = workers.health();
        workers.spawn("inventory-expiry", async {
            panic!("worker failure fixture")
        });
        assert_eq!(
            workers.next_failure().await,
            Some(Failure {
                name: "inventory-expiry",
                reason: FailureReason::Panicked
            })
        );
        assert_eq!(health.status(), "unavailable");
    }

    #[tokio::test]
    async fn empty_supervisor_has_no_failure() {
        let mut workers = Supervisor::default();
        assert!(workers.is_empty());
        assert_eq!(workers.next_failure().await, None);
        assert_eq!(workers.health().status(), "not_configured");
    }

    #[tokio::test]
    async fn exit_invalidates_health_before_supervisor_is_polled() {
        let mut workers = Supervisor::default();
        let health = workers.health();
        let (finished, completion) = tokio::sync::oneshot::channel();
        workers.spawn("outbox", async move {
            let _ = finished.send(());
        });
        completion.await.unwrap();
        assert!(!health.available());
        assert!(workers.next_failure().await.is_some());
    }

    #[tokio::test]
    async fn shutdown_cancellation_is_expected() {
        let mut workers = Supervisor::default();
        workers.spawn("outbox", std::future::pending());
        let health = workers.health();
        assert_eq!(health.status(), "running");
        workers.shutdown().await;
        assert!(workers.is_empty());
        assert!(!health.0.failed.load(Ordering::Acquire));
        assert_eq!(health.status(), "unavailable");
    }
}
