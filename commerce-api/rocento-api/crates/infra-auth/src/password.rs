//! A process-wide budget for memory/CPU-heavy password work. Both execution and
//! waiting are bounded before anything is submitted to Tokio's blocking pool.
use crate::{validate_password, Error, Result};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PasswordHashConfig {
    pub max_concurrency: usize,
    pub wait_timeout: Duration,
}

impl Default for PasswordHashConfig {
    fn default() -> Self {
        Self {
            max_concurrency: 2,
            wait_timeout: Duration::from_millis(250),
        }
    }
}

impl PasswordHashConfig {
    pub fn validate(self) -> Result<Self> {
        if !(1..=32).contains(&self.max_concurrency) {
            return Err(Error::Invalid(
                "PASSWORD_HASH_MAX_CONCURRENCY must be between 1 and 32".into(),
            ));
        }
        if !(Duration::from_millis(1)..=Duration::from_secs(5)).contains(&self.wait_timeout) {
            return Err(Error::Invalid(
                "PASSWORD_HASH_WAIT_TIMEOUT_MS must be between 1 and 5000".into(),
            ));
        }
        Ok(self)
    }
}

static PASSWORD_WORK: OnceLock<PasswordGate> = OnceLock::new();

/// Configure once before constructing Security or accepting requests. Late
/// changes cannot replace a budget while existing blocking jobs still use it.
pub fn configure(config: PasswordHashConfig) -> Result<()> {
    let config = config.validate()?;
    match PASSWORD_WORK.set(PasswordGate::new(config)) {
        Ok(()) => Ok(()),
        Err(_)
            if PASSWORD_WORK
                .get()
                .is_some_and(|gate| gate.config == config) =>
        {
            Ok(())
        }
        Err(_) => Err(Error::Invalid(
            "Password hashing was already initialized with a different budget".into(),
        )),
    }
}

fn gate() -> &'static PasswordGate {
    PASSWORD_WORK.get_or_init(|| PasswordGate::new(PasswordHashConfig::default()))
}

pub async fn hash_password(value: String) -> Result<String> {
    gate().hash(value).await
}

/// Invalid credentials remain Ok(false). Capacity exhaustion is an explicit
/// error so callers can offer a short retry instead of reporting a bad password.
pub async fn verify_password(value: String, hash: String) -> Result<bool> {
    gate().verify(value, hash).await
}

struct PasswordGate {
    config: PasswordHashConfig,
    running: Arc<Semaphore>,
    waiting: Arc<Semaphore>,
}

impl PasswordGate {
    fn new(config: PasswordHashConfig) -> Self {
        Self {
            config,
            running: Arc::new(Semaphore::new(config.max_concurrency)),
            waiting: Arc::new(Semaphore::new(2 * config.max_concurrency)),
        }
    }

    async fn permit(&self) -> Result<OwnedSemaphorePermit> {
        match self.running.clone().try_acquire_owned() {
            Ok(permit) => return Ok(permit),
            Err(TryAcquireError::Closed) => return Err(Error::Internal),
            Err(TryAcquireError::NoPermits) => {}
        }
        let waiting = self
            .waiting
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let permit = tokio::time::timeout(
            self.config.wait_timeout,
            self.running.clone().acquire_owned(),
        )
        .await
        .map_err(|_| Error::Busy)?
        .map_err(|_| Error::Internal)?;
        drop(waiting);
        Ok(permit)
    }

    async fn run<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        let permit = self.permit().await?;
        tokio::task::spawn_blocking(move || {
            // Cancellation of the async caller cannot release execution capacity
            // while this queued/running blocking job is still consuming resources.
            let _permit = permit;
            work()
        })
        .await
        .map_err(|_| Error::Internal)
    }

    async fn hash(&self, value: String) -> Result<String> {
        validate_password(&value)?;
        self.run(move || {
            Argon2::default()
                .hash_password(
                    value.as_bytes(),
                    &SaltString::generate(&mut rand::rngs::OsRng),
                )
                .map(|value| value.to_string())
                .map_err(|_| Error::Internal)
        })
        .await?
    }

    async fn verify(&self, value: String, hash: String) -> Result<bool> {
        if value.len() > 128 {
            return Ok(false);
        }
        self.run(move || {
            PasswordHash::new(&hash).is_ok_and(|hash| {
                Argon2::default()
                    .verify_password(value.as_bytes(), &hash)
                    .is_ok()
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Condvar, Mutex,
    };

    struct ReleaseOnDrop(Arc<(Mutex<bool>, Condvar)>);
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            let (lock, release) = &*self.0;
            *lock.lock().unwrap_or_else(|error| error.into_inner()) = true;
            release.notify_all();
        }
    }

    fn test_gate(max_concurrency: usize, milliseconds: u64) -> Arc<PasswordGate> {
        let config = PasswordHashConfig {
            max_concurrency,
            wait_timeout: Duration::from_millis(milliseconds),
        }
        .validate()
        .unwrap();
        Arc::new(PasswordGate::new(config))
    }

    async fn until(condition: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !condition() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("condition did not become true");
    }

    fn blocked_job(
        gate: Arc<PasswordGate>,
    ) -> (
        tokio::task::JoinHandle<Result<()>>,
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (started, start) = tokio::sync::oneshot::channel();
        let (release, receive) = std::sync::mpsc::channel();
        let task = tokio::spawn(async move {
            gate.run(move || {
                let _ = started.send(());
                let _ = receive.recv();
            })
            .await
        });
        (task, start, release)
    }

    #[tokio::test]
    async fn salted_hashes_preserve_correct_wrong_and_invalid_password_semantics() {
        let gate = test_gate(1, 1000);
        let password = "Testing password 123!".to_string();
        let first = gate.hash(password.clone()).await.unwrap();
        let second = gate.hash(password.clone()).await.unwrap();
        assert_ne!(first, second);
        assert!(first.starts_with("$argon2id$"));
        assert!(gate.verify(password, first.clone()).await.unwrap());
        assert!(!gate.verify("wrong".into(), first).await.unwrap());
        assert!(!gate
            .verify("wrong".into(), "invalid hash".into())
            .await
            .unwrap());
        assert!(!gate.verify("x".repeat(129), second).await.unwrap());
        assert!(matches!(
            gate.hash("short".into()).await,
            Err(Error::Invalid(_))
        ));
    }

    #[tokio::test]
    async fn running_work_survives_caller_cancellation_and_keeps_its_permit() {
        let gate = test_gate(1, 20);
        let (task, started, release) = blocked_job(gate.clone());
        started.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(gate.running.available_permits(), 0);
        assert!(matches!(gate.run(|| ()).await, Err(Error::Busy)));
        release.send(()).unwrap();
        until(|| gate.running.available_permits() == 1).await;
        assert!(gate.run(|| ()).await.is_ok());
    }

    #[tokio::test]
    async fn bounded_waiting_rejects_overflow_and_releases_cancelled_waiters() {
        let gate = test_gate(1, 1000);
        let (task, started, release) = blocked_job(gate.clone());
        started.await.unwrap();
        let first = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.run(|| ()).await })
        };
        let second = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.run(|| ()).await })
        };
        until(|| gate.waiting.available_permits() == 0).await;
        let rejected = tokio::time::timeout(Duration::from_millis(100), gate.run(|| ()))
            .await
            .unwrap();
        assert!(matches!(rejected, Err(Error::Busy)));
        first.abort();
        second.abort();
        let _ = first.await;
        let _ = second.await;
        assert_eq!(gate.waiting.available_permits(), 2);
        release.send(()).unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn waiting_has_a_deadline_and_does_not_start_rejected_work() {
        let gate = test_gate(1, 20);
        let (task, started, release) = blocked_job(gate.clone());
        started.await.unwrap();
        let executed = Arc::new(AtomicUsize::new(0));
        let work_counter = executed.clone();
        assert!(matches!(
            gate.run(move || work_counter.fetch_add(1, Ordering::SeqCst))
                .await,
            Err(Error::Busy)
        ));
        assert!(matches!(
            gate.verify("wrong".into(), "invalid hash".into()).await,
            Err(Error::Busy)
        ));
        assert!(matches!(
            gate.hash("Testing password 123!".into()).await,
            Err(Error::Busy)
        ));
        assert_eq!(executed.load(Ordering::SeqCst), 0);
        assert_eq!(gate.waiting.available_permits(), 2);
        release.send(()).unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn concurrent_jobs_never_exceed_the_execution_budget() {
        let gate = test_gate(2, 1000);
        let barrier = Arc::new((Mutex::new(false), Condvar::new()));
        let _release_on_drop = ReleaseOnDrop(barrier.clone());
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut jobs = Vec::new();
        for _ in 0..6 {
            let (gate, barrier, active, peak) =
                (gate.clone(), barrier.clone(), active.clone(), peak.clone());
            jobs.push(tokio::spawn(async move {
                gate.run(move || {
                    let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(count, Ordering::SeqCst);
                    let (lock, released) = &*barrier;
                    let mut release = lock.lock().unwrap();
                    while !*release {
                        release = released.wait(release).unwrap();
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                })
                .await
            }));
        }
        until(|| active.load(Ordering::SeqCst) == 2 && gate.waiting.available_permits() == 0).await;
        assert!(matches!(gate.run(|| ()).await, Err(Error::Busy)));
        let (lock, released) = &*barrier;
        *lock.lock().unwrap() = true;
        released.notify_all();
        for job in jobs {
            job.await.unwrap().unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn hashing_configuration_is_bounded() {
        assert!(PasswordHashConfig::default().validate().is_ok());
        for max_concurrency in [0, 33, usize::MAX] {
            assert!(PasswordHashConfig {
                max_concurrency,
                ..Default::default()
            }
            .validate()
            .is_err());
        }
        for wait_timeout in [Duration::ZERO, Duration::from_millis(5001)] {
            assert!(PasswordHashConfig {
                wait_timeout,
                ..Default::default()
            }
            .validate()
            .is_err());
        }
    }
}
