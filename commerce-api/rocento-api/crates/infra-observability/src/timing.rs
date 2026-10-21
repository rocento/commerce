//! Timing families with a fixed set of operations and outcomes.
//!
//! These helpers accept no request arguments, IDs, SQL, or error messages.
use std::{
    collections::BTreeMap,
    fmt::Write,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const SECONDS_BOUNDS: [f64; 13] = [
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0,
];
const BATCH_BOUNDS: [u64; 9] = [0, 1, 10, 25, 50, 100, 250, 500, 1000];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Operation {
    DbPoolAcquire,
    InventoryLockWait,
    InventoryTransaction,
    InventoryExpiry,
    CartSnapshot,
}

impl Operation {
    const ALL: [Self; 5] = [
        Self::DbPoolAcquire,
        Self::InventoryLockWait,
        Self::InventoryTransaction,
        Self::InventoryExpiry,
        Self::CartSnapshot,
    ];

    fn metric_name(self) -> &'static str {
        match self {
            Self::DbPoolAcquire => "commerce_db_pool_acquire_seconds",
            Self::InventoryLockWait => "commerce_inventory_lock_wait_seconds",
            Self::InventoryTransaction => "commerce_inventory_transaction_seconds",
            Self::InventoryExpiry => "commerce_inventory_expiry_seconds",
            Self::CartSnapshot => "commerce_cart_snapshot_seconds",
        }
    }

    fn unfinished_result(self) -> OperationResult {
        match self {
            // An unfinished command can be rejected, fail, or be cancelled.
            // This says it did not finish; it does not confirm DB rollback.
            Self::InventoryTransaction => OperationResult::Aborted,
            _ => OperationResult::Cancelled,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum OperationResult {
    Success,
    Error,
    Timeout,
    Cancelled,
    Aborted,
}

impl OperationResult {
    fn label(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Error => "error",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::Aborted => "aborted",
        }
    }
}

#[derive(Default)]
struct DurationHistogram {
    count: u64,
    seconds: f64,
    buckets: [u64; SECONDS_BOUNDS.len()],
}

impl DurationHistogram {
    fn observe(&mut self, elapsed: Duration) {
        let seconds = elapsed.as_secs_f64();
        self.count += 1;
        self.seconds += seconds;
        for (index, bound) in SECONDS_BOUNDS.iter().enumerate() {
            if seconds <= *bound {
                self.buckets[index] += 1;
            }
        }
    }
}

#[derive(Default)]
struct BatchHistogram {
    count: u64,
    items: u64,
    buckets: [u64; BATCH_BOUNDS.len()],
}

impl BatchHistogram {
    fn observe(&mut self, items: u64) {
        self.count += 1;
        self.items = self.items.saturating_add(items);
        for (index, bound) in BATCH_BOUNDS.iter().enumerate() {
            if items <= *bound {
                self.buckets[index] += 1;
            }
        }
    }
}

#[derive(Default)]
struct TimingMetrics {
    durations: BTreeMap<(Operation, OperationResult), DurationHistogram>,
    expiry_batches: BatchHistogram,
}

impl TimingMetrics {
    fn observe(&mut self, operation: Operation, result: OperationResult, elapsed: Duration) {
        self.durations
            .entry((operation, result))
            .or_default()
            .observe(elapsed);
    }

    fn render(&self, out: &mut String) {
        for operation in Operation::ALL {
            let _ = writeln!(out, "# TYPE {} histogram", operation.metric_name());
        }
        for ((operation, result), metric) in &self.durations {
            let name = operation.metric_name();
            let labels = format!("result=\"{}\"", result.label());
            let _ = writeln!(
                out,
                "{name}_sum{{{labels}}} {}\n{name}_count{{{labels}}} {}",
                metric.seconds, metric.count
            );
            for (index, bound) in SECONDS_BOUNDS.iter().enumerate() {
                let _ = writeln!(
                    out,
                    "{name}_bucket{{{labels},le=\"{bound}\"}} {}",
                    metric.buckets[index]
                );
            }
            let _ = writeln!(
                out,
                "{name}_bucket{{{labels},le=\"+Inf\"}} {}",
                metric.count
            );
        }
        const BATCH: &str = "commerce_inventory_expiry_batch_size";
        let _ = writeln!(
            out,
            "# TYPE {BATCH} histogram\n{BATCH}_sum {}\n{BATCH}_count {}",
            self.expiry_batches.items, self.expiry_batches.count
        );
        for (index, bound) in BATCH_BOUNDS.iter().enumerate() {
            let _ = writeln!(
                out,
                "{BATCH}_bucket{{le=\"{bound}\"}} {}",
                self.expiry_batches.buckets[index]
            );
        }
        let _ = writeln!(
            out,
            "{BATCH}_bucket{{le=\"+Inf\"}} {}",
            self.expiry_batches.count
        );
    }
}

static TIMINGS: OnceLock<Mutex<TimingMetrics>> = OnceLock::new();

fn observe(operation: Operation, result: OperationResult, elapsed: Duration) {
    TIMINGS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .observe(operation, result, elapsed);
}

/// Measures the scope from construction through completion or drop.
///
/// Finish once the measured operation succeeds or returns an error. Dropping an
/// unfinished timer records cancellation, except inventory transactions, which
/// record an aborted command. Neither outcome confirms a physical DB rollback.
#[must_use = "keep the timer alive through the operation and finish its outcome"]
#[derive(Debug)]
pub struct OperationTimer {
    operation: Operation,
    started: Instant,
    finished: bool,
}

impl OperationTimer {
    pub fn new(operation: Operation) -> Self {
        Self {
            operation,
            started: Instant::now(),
            finished: false,
        }
    }

    pub fn finish(mut self, result: OperationResult) {
        self.finished = true;
        observe(self.operation, result, self.started.elapsed());
    }
}

impl Drop for OperationTimer {
    fn drop(&mut self) {
        if !self.finished {
            observe(
                self.operation,
                self.operation.unfinished_result(),
                self.started.elapsed(),
            );
        }
    }
}

/// Records the number of rows actually handled in one expiry batch.
pub fn inventory_expiry_batch_size(count: u64) {
    TIMINGS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .expiry_batches
        .observe(count);
}

/// A point-in-time sample; concurrent pool activity can change it immediately.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DbPoolSnapshot {
    pub size: u32,
    pub idle: usize,
    pub max_connections: u32,
}

static DB_POOL: OnceLock<Mutex<DbPoolSnapshot>> = OnceLock::new();

/// Stores numeric pool gauges only; no pool or connection is retained.
pub fn record_db_pool_snapshot(snapshot: DbPoolSnapshot) {
    *DB_POOL
        .get_or_init(|| Mutex::new(snapshot))
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = snapshot;
}

pub(crate) fn append_metrics(out: &mut String) {
    TIMINGS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .render(out);
    if let Some(pool) = DB_POOL.get() {
        let snapshot = pool.lock().unwrap_or_else(|error| error.into_inner());
        let _ = writeln!(out,
            "# TYPE commerce_db_pool_connections gauge\ncommerce_db_pool_connections {}\n# TYPE commerce_db_pool_idle_connections gauge\ncommerce_db_pool_idle_connections {}\n# TYPE commerce_db_pool_max_connections gauge\ncommerce_db_pool_max_connections {}",
            snapshot.size, snapshot.idle, snapshot.max_connections);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histograms_have_cumulative_buckets_and_fixed_labels() {
        let mut metrics = TimingMetrics::default();
        metrics.observe(
            Operation::DbPoolAcquire,
            OperationResult::Success,
            Duration::from_millis(7),
        );
        metrics.observe(
            Operation::DbPoolAcquire,
            OperationResult::Success,
            Duration::from_millis(20),
        );
        metrics.observe(
            Operation::InventoryLockWait,
            OperationResult::Timeout,
            Duration::from_secs(40),
        );
        metrics.observe(
            Operation::CartSnapshot,
            OperationResult::Success,
            Duration::from_millis(7),
        );
        metrics.observe(
            Operation::CartSnapshot,
            OperationResult::Error,
            Duration::from_millis(20),
        );
        metrics.expiry_batches.observe(0);
        metrics.expiry_batches.observe(128);
        let mut rendered = String::new();
        metrics.render(&mut rendered);
        for expected in [
            "commerce_db_pool_acquire_seconds_sum{result=\"success\"} 0.027\n",
            "commerce_db_pool_acquire_seconds_count{result=\"success\"} 2\n",
            "commerce_db_pool_acquire_seconds_bucket{result=\"success\",le=\"0.005\"} 0\n",
            "commerce_db_pool_acquire_seconds_bucket{result=\"success\",le=\"0.01\"} 1\n",
            "commerce_db_pool_acquire_seconds_bucket{result=\"success\",le=\"0.025\"} 2\n",
            "commerce_db_pool_acquire_seconds_bucket{result=\"success\",le=\"+Inf\"} 2\n",
            "commerce_inventory_lock_wait_seconds_bucket{result=\"timeout\",le=\"30\"} 0\n",
            "commerce_inventory_lock_wait_seconds_bucket{result=\"timeout\",le=\"+Inf\"} 1\n",
            "commerce_cart_snapshot_seconds_count{result=\"success\"} 1\n",
            "commerce_cart_snapshot_seconds_bucket{result=\"success\",le=\"0.01\"} 1\n",
            "commerce_cart_snapshot_seconds_count{result=\"error\"} 1\n",
            "commerce_cart_snapshot_seconds_bucket{result=\"error\",le=\"0.025\"} 1\n",
            "commerce_inventory_expiry_batch_size_sum 128\n",
            "commerce_inventory_expiry_batch_size_count 2\n",
            "commerce_inventory_expiry_batch_size_bucket{le=\"0\"} 1\n",
            "commerce_inventory_expiry_batch_size_bucket{le=\"100\"} 1\n",
            "commerce_inventory_expiry_batch_size_bucket{le=\"250\"} 2\n",
        ] {
            assert!(rendered.contains(expected), "missing {expected:?}");
        }
        for line in rendered.lines().filter(|line| line.contains('{')) {
            let labels = line.split_once('{').unwrap().1.split_once('}').unwrap().0;
            assert!(labels
                .split(',')
                .all(|label| label.starts_with("result=") || label.starts_with("le=")));
        }
    }

    fn count(operation: Operation, result: OperationResult) -> u64 {
        TIMINGS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .durations
            .get(&(operation, result))
            .map_or(0, |metric| metric.count)
    }

    #[tokio::test]
    async fn finishing_records_once_and_task_abort_records_unfinished_outcomes() {
        let success_before = count(Operation::InventoryTransaction, OperationResult::Success);
        let aborted_before = count(Operation::InventoryTransaction, OperationResult::Aborted);
        let cancelled_before = count(Operation::InventoryLockWait, OperationResult::Cancelled);
        let snapshot_before = count(Operation::CartSnapshot, OperationResult::Cancelled);
        OperationTimer::new(Operation::InventoryTransaction).finish(OperationResult::Success);
        assert_eq!(
            count(Operation::InventoryTransaction, OperationResult::Success),
            success_before + 1
        );
        assert_eq!(
            count(Operation::InventoryTransaction, OperationResult::Aborted),
            aborted_before
        );

        let started = std::sync::Arc::new(tokio::sync::Notify::new());
        let signal = started.clone();
        let task = tokio::spawn(async move {
            let _transaction = OperationTimer::new(Operation::InventoryTransaction);
            let _lock = OperationTimer::new(Operation::InventoryLockWait);
            let _snapshot = OperationTimer::new(Operation::CartSnapshot);
            signal.notify_one();
            std::future::pending::<()>().await;
        });
        started.notified().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            count(Operation::InventoryTransaction, OperationResult::Aborted),
            aborted_before + 1
        );
        assert_eq!(
            count(Operation::InventoryLockWait, OperationResult::Cancelled),
            cancelled_before + 1
        );
        assert_eq!(
            count(Operation::CartSnapshot, OperationResult::Cancelled),
            snapshot_before + 1
        );
    }

    #[tokio::test]
    async fn existing_metric_families_and_numeric_pool_gauges_are_exported_together() {
        record_db_pool_snapshot(DbPoolSnapshot {
            size: 4,
            idle: 2,
            max_connections: 10,
        });
        let (headers, text) = crate::metrics().await;
        assert_eq!(headers, [("content-type", "text/plain; version=0.0.4")]);
        for expected in [
            "# TYPE commerce_http_requests_total counter\n",
            "# TYPE commerce_http_duration_seconds histogram\n",
            "# TYPE commerce_reporting_last_success_seconds gauge\n",
            "# TYPE commerce_inventory_expiry_seconds histogram\n",
            "# TYPE commerce_cart_snapshot_seconds histogram\n",
            "commerce_db_pool_connections 4\n",
            "commerce_db_pool_idle_connections 2\n",
            "commerce_db_pool_max_connections 10\n",
        ] {
            assert!(text.contains(expected), "missing {expected:?}");
        }
    }
}
