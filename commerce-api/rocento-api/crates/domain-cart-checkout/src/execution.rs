//! Durable execution receipts for the registered Rust quote/apply capabilities.
//! This module stores no model reasoning and never authorizes a mutation itself.
use crate::shopping::{Goal, Mode, Proposal};
use crate::*;
use chrono::{DateTime, Utc};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Created,
    Planned,
    Executing,
    Verifying,
    Replanning,
    NeedsInput,
    AwaitingConfirmation,
    Completed,
    Cancelled,
    Expired,
    Blocked,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Pass,
    NeedsInput,
    Stale,
    Blocked,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub product_id: Uuid,
    pub price: String,
    pub currency: String,
    pub unit: String,
    pub quantity: i32,
    pub available: Option<i64>,
    pub observed_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub source: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionEnvelope {
    pub store_id: Uuid,
    pub cart_id: Uuid,
    pub customer_id: Option<Uuid>,
    pub scope: String,
    pub risk: String,
    pub confirmation: String,
    pub proposal_id: Uuid,
    pub idempotency_key: Option<Uuid>,
    pub expected_revision: i64,
    pub expires_at: DateTime<Utc>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub schema_version: String,
    pub goal_id: Uuid,
    pub revision: i64,
    pub state: State,
    pub verdict: Verdict,
    pub playbook: String,
    pub version: String,
    pub proposal_id: Uuid,
    pub observed_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub reasons: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub receipt: Receipt,
    pub saved_by_customer: bool,
    pub goal_expires_at: DateTime<Utc>,
    pub goal: Goal,
    pub selected: Vec<Uuid>,
    pub rejected: Vec<Uuid>,
    pub skill_versions: Vec<String>,
    pub transitions: Vec<State>,
    pub observations: Vec<Observation>,
    pub envelope: ActionEnvelope,
    pub revalidations: u32,
    pub max_revalidations: u32,
    pub failed_verifications: u32,
    pub max_failed_verifications: u32,
    pub max_parallelism: u32,
    pub max_mutations: u32,
    pub deadline_ms: u32,
}
impl Checkpoint {
    pub fn transition(&mut self, state: State) -> Result<()> {
        let allowed = match self.receipt.state {
            State::Created => matches!(state, State::Planned | State::Cancelled | State::Expired),
            State::Planned => matches!(state, State::Executing | State::Cancelled | State::Expired),
            State::Executing => {
                matches!(state, State::Verifying | State::Cancelled | State::Expired)
            }
            State::Verifying => matches!(
                state,
                State::AwaitingConfirmation | State::NeedsInput | State::Blocked
            ),
            State::AwaitingConfirmation => matches!(
                state,
                State::Completed
                    | State::Planned
                    | State::Replanning
                    | State::NeedsInput
                    | State::Cancelled
                    | State::Expired
                    | State::Blocked
            ),
            State::NeedsInput | State::Blocked => matches!(
                state,
                State::Planned
                    | State::Replanning
                    | State::Cancelled
                    | State::Expired
                    | State::Blocked
            ),
            State::Replanning => matches!(
                state,
                State::Planned | State::Blocked | State::Cancelled | State::Expired
            ),
            State::Completed | State::Cancelled | State::Expired => false,
        };
        if !allowed {
            return Err(Error::Conflict);
        }
        self.receipt.state = state;
        self.transitions.push(state);
        if self.transitions.len() > 16 {
            self.transitions.remove(0);
        }
        Ok(())
    }
    pub fn terminal(&self) -> bool {
        matches!(
            self.receipt.state,
            State::Completed | State::Cancelled | State::Expired
        )
    }
}
pub async fn enabled(tx: &mut Tx<'_>) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT enabled FROM cart_checkout.execution_config WHERE singleton")
            .fetch_one(&mut **tx)
            .await?,
    )
}
pub async fn load(tx: &mut Tx<'_>, cart: Uuid, task: Uuid) -> Result<Option<Checkpoint>> {
    let value: Option<serde_json::Value> = sqlx::query_scalar("SELECT checkpoint FROM cart_checkout.goal_checkpoints WHERE task_id=$1 AND cart_id=$2 FOR UPDATE")
        .bind(task).bind(cart).fetch_optional(&mut **tx).await?;
    let checkpoint: Option<Checkpoint> = value
        .map(|v| serde_json::from_value(v).map_err(|_| Error::Internal))
        .transpose()?;
    if let Some(c) = &checkpoint {
        let store: Uuid = sqlx::query_scalar(
            "SELECT store_id FROM cart_checkout.execution_config WHERE singleton",
        )
        .fetch_one(&mut **tx)
        .await?;
        if c.receipt.schema_version != "1.0"
            || c.receipt.version != "1.0.0"
            || c.envelope.store_id != store
            || c.envelope.cart_id != cart
            || c.receipt.goal_id != task
        {
            return Err(Error::NotFound);
        }
    }
    Ok(checkpoint)
}
pub async fn save(tx: &mut Tx<'_>, cart: Uuid, checkpoint: &mut Checkpoint) -> Result<()> {
    let previous = checkpoint.receipt.revision;
    checkpoint.receipt.revision += 1;
    let result = sqlx::query("INSERT INTO cart_checkout.goal_checkpoints(task_id,cart_id,revision,checkpoint) VALUES($1,$2,$3,$4) ON CONFLICT(task_id) DO UPDATE SET revision=$3,checkpoint=$4,updated_at=now() WHERE goal_checkpoints.cart_id=$2 AND goal_checkpoints.revision=$5")
        .bind(checkpoint.receipt.goal_id).bind(cart).bind(checkpoint.receipt.revision).bind(json!(checkpoint)).bind(previous).execute(&mut **tx).await?;
    if result.rows_affected() != 1 {
        return Err(Error::Conflict);
    }
    infra_events::record(tx,"shopping.execution_checkpoint",json!({"task_id":checkpoint.receipt.goal_id,"revision":checkpoint.receipt.revision,"state":checkpoint.receipt.state,"verdict":checkpoint.receipt.verdict,"playbook":checkpoint.receipt.playbook,"version":checkpoint.receipt.version})).await?;
    Ok(())
}
pub async fn quote(
    tx: &mut Tx<'_>,
    cart: Uuid,
    customer: Option<Uuid>,
    p: &Proposal,
    previous: Option<Checkpoint>,
    resumed: bool,
) -> Result<Option<Checkpoint>> {
    if !enabled(tx).await? {
        return Ok(None);
    }
    let now = Utc::now();
    let store_id: Uuid =
        sqlx::query_scalar("SELECT store_id FROM cart_checkout.execution_config WHERE singleton")
            .fetch_one(&mut **tx)
            .await?;
    let mode = match p.draft.mode {
        Mode::Shop => "shop",
        Mode::Optimize => "optimize",
        Mode::BuyAgain => "buy-again-ui",
    };
    let mut c = previous.unwrap_or_else(|| Checkpoint {
        receipt: Receipt {
            schema_version: "1.0".into(),
            goal_id: p.draft.task_id,
            revision: 0,
            state: State::Created,
            verdict: Verdict::NeedsInput,
            playbook: format!("playbook://commerce/{mode}"),
            version: "1.0.0".into(),
            proposal_id: p.id,
            observed_at: now,
            expires_at: p.expires_at,
            reasons: vec![],
        },
        saved_by_customer: false,
        goal_expires_at: now + chrono::Duration::hours(24),
        goal: p.draft.goal.clone(),
        selected: vec![],
        rejected: vec![],
        skill_versions: vec![
            "skill://cart/context@1.0.0".into(),
            "skill://cart/quote-proposal@1.0.0".into(),
            "verifier://commerce/quote@1.0.0".into(),
        ],
        transitions: vec![State::Created],
        observations: vec![],
        envelope: ActionEnvelope {
            store_id,
            cart_id: cart,
            customer_id: customer,
            scope: "cart_read_propose".into(),
            risk: "R0".into(),
            confirmation: "none".into(),
            proposal_id: p.id,
            idempotency_key: None,
            expected_revision: p.draft.source_revision,
            expires_at: p.expires_at,
        },
        revalidations: 0,
        max_revalidations: 3,
        failed_verifications: 0,
        max_failed_verifications: 2,
        max_parallelism: 1,
        max_mutations: 1,
        deadline_ms: 5000,
    });
    if c.terminal() || c.goal_expires_at <= now {
        return Err(Error::Invalid(
            "Goal expired or completed. Start a new shopping task.".into(),
        ));
    }
    if c.envelope.customer_id != customer {
        return Err(Error::NotFound);
    }
    if resumed {
        c.revalidations += 1;
        c.transition(State::Replanning)?;
    } else {
        c.failed_verifications = 0;
    }
    c.transition(State::Planned)?;
    c.transition(State::Executing)?;
    c.transition(State::Verifying)?;
    c.receipt.proposal_id = p.id;
    c.receipt.observed_at = now;
    c.receipt.expires_at = p.expires_at;
    c.receipt.verdict = if p.can_apply {
        Verdict::Pass
    } else {
        Verdict::NeedsInput
    };
    c.receipt.reasons = if p.can_apply {
        vec![]
    } else {
        vec!["unresolved_constraints".into()]
    };
    if p.lines
        .iter()
        .any(|l| l.product.is_none() || l.available < i64::from(l.selection.quantity))
    {
        c.receipt.reasons.push("unavailable_item".into());
    }
    c.goal = p.draft.goal.clone();
    c.selected = p.draft.selections.iter().map(|s| s.product_id).collect();
    c.rejected = p.draft.goal.excluded_products.clone();
    c.observations = p
        .resulting_items
        .iter()
        .map(|i| Observation {
            product_id: i.product_id,
            price: i.price.clone(),
            currency: i.currency.clone(),
            unit: i.unit.clone(),
            quantity: i.quantity,
            available: p
                .lines
                .iter()
                .find(|l| l.selection.product_id == i.product_id)
                .map(|l| l.available),
            observed_at: now,
            expires_at: p.expires_at,
            source: format!("proposal:{}", p.id),
        })
        .collect();
    c.envelope = ActionEnvelope {
        store_id,
        cart_id: cart,
        customer_id: customer,
        scope: "cart_read_propose".into(),
        risk: "R0".into(),
        confirmation: "none".into(),
        proposal_id: p.id,
        idempotency_key: None,
        expected_revision: p.draft.source_revision,
        expires_at: p.expires_at,
    };
    if !p.can_apply {
        c.failed_verifications += 1;
    }
    c.transition(if p.can_apply {
        State::AwaitingConfirmation
    } else {
        State::NeedsInput
    })?;
    save(tx, cart, &mut c).await?;
    Ok(Some(c))
}
pub async fn finish(
    tx: &mut Tx<'_>,
    cart: Uuid,
    task: Uuid,
    state: State,
    key: Option<Uuid>,
) -> Result<()> {
    if let Some(mut c) = load(tx, cart, task).await? {
        if c.terminal() {
            return Ok(());
        }
        c.transition(state)?;
        if state == State::Completed {
            c.receipt.verdict = Verdict::Pass;
            c.envelope.risk = "R2".into();
            c.envelope.scope = "cart_write".into();
            c.envelope.confirmation = "consumed".into();
            c.envelope.idempotency_key = key;
        }
        save(tx, cart, &mut c).await?;
    }
    Ok(())
}

impl Service {
    pub async fn execution_goal(
        &self,
        cart: Uuid,
        customer: Option<Uuid>,
        task: Uuid,
    ) -> Result<Checkpoint> {
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        Self::shopping_owner(&mut tx, cart, customer).await?;
        if !enabled(&mut tx).await? {
            return Err(Error::NotFound);
        }
        let archived: bool = sqlx::query_scalar(
            "SELECT archived FROM cart_checkout.goal_checkpoints WHERE task_id=$1 AND cart_id=$2",
        )
        .bind(task)
        .bind(cart)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or(false);
        if archived {
            return Err(Error::Invalid(
                "Unarchive the saved goal before continuing".into(),
            ));
        }
        let mut c = load(&mut tx, cart, task).await?.ok_or(Error::NotFound)?;
        if c.envelope.customer_id != customer {
            return Err(Error::NotFound);
        }
        if !c.terminal() && c.goal_expires_at <= Utc::now() {
            c.transition(State::Expired)?;
            save(&mut tx, cart, &mut c).await?;
        }
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(c)
    }
    pub async fn save_execution_goal(
        &self,
        cart: Uuid,
        customer: Option<Uuid>,
        task: Uuid,
        expected: i64,
    ) -> Result<Checkpoint> {
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        Self::shopping_owner(&mut tx, cart, customer).await?;
        if !enabled(&mut tx).await? {
            return Err(Error::NotFound);
        }
        let archived: bool = sqlx::query_scalar(
            "SELECT archived FROM cart_checkout.goal_checkpoints WHERE task_id=$1 AND cart_id=$2",
        )
        .bind(task)
        .bind(cart)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or(false);
        if archived {
            return Err(Error::Invalid(
                "Unarchive the saved goal before continuing".into(),
            ));
        }
        let mut c = load(&mut tx, cart, task).await?.ok_or(Error::NotFound)?;
        if c.envelope.customer_id != customer {
            return Err(Error::NotFound);
        }
        if c.receipt.revision != expected {
            return Err(Error::Conflict);
        }
        if c.terminal() || c.goal_expires_at <= Utc::now() {
            return Err(Error::Invalid(
                "This goal expired or completed. Start a new shopping task.".into(),
            ));
        }
        c.saved_by_customer = true;
        save(&mut tx, cart, &mut c).await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(c)
    }
    pub async fn resume_execution_goal(
        &self,
        cart: Uuid,
        customer: Option<Uuid>,
        task: Uuid,
        expected: i64,
    ) -> Result<Proposal> {
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        Self::shopping_owner(&mut tx, cart, customer).await?;
        if !enabled(&mut tx).await? {
            return Err(Error::NotFound);
        }
        let archived: bool = sqlx::query_scalar(
            "SELECT archived FROM cart_checkout.goal_checkpoints WHERE task_id=$1 AND cart_id=$2",
        )
        .bind(task)
        .bind(cart)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or(false);
        if archived {
            return Err(Error::Invalid(
                "Unarchive the saved goal before continuing".into(),
            ));
        }
        let mut c = load(&mut tx, cart, task).await?.ok_or(Error::NotFound)?;
        if c.envelope.customer_id != customer {
            return Err(Error::NotFound);
        }
        if c.receipt.revision != expected {
            return Err(Error::Conflict);
        }
        if c.terminal() || !c.saved_by_customer {
            return Err(Error::Invalid(
                "Save this goal before resuming, or start a new shopping task.".into(),
            ));
        }
        if c.goal_expires_at <= Utc::now() {
            c.transition(State::Expired)?;
            save(&mut tx, cart, &mut c).await?;
            let committed = tx.commit().await;
            timer.finish(if committed.is_ok() {
                infra_observability::OperationResult::Success
            } else {
                infra_observability::OperationResult::Error
            });
            committed?;
            return Err(Error::Invalid(
                "Saved goal expired. Start a new shopping task.".into(),
            ));
        }
        if c.revalidations >= c.max_revalidations
            || c.failed_verifications >= c.max_failed_verifications
        {
            c.transition(State::Blocked)?;
            c.receipt.verdict = Verdict::Blocked;
            c.receipt.reasons = vec!["replan_budget_exhausted".into()];
            save(&mut tx, cart, &mut c).await?;
            let committed = tx.commit().await;
            timer.finish(if committed.is_ok() {
                infra_observability::OperationResult::Success
            } else {
                infra_observability::OperationResult::Error
            });
            committed?;
            return Err(Error::Invalid(
                "Goal revalidation stopped. Review unresolved constraints or start a new task."
                    .into(),
            ));
        }
        let raw: serde_json::Value=sqlx::query_scalar("SELECT draft FROM cart_checkout.shopping_tasks WHERE id=$1 AND cart_id=$2 AND NOT cancelled").bind(task).bind(cart).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        let mut draft: crate::shopping::Draft =
            serde_json::from_value(raw).map_err(|_| Error::Internal)?;
        draft.source_revision =
            sqlx::query_scalar("SELECT revision FROM cart_checkout.carts WHERE id=$1")
                .bind(cart)
                .fetch_one(&mut *tx)
                .await?;
        draft.auto_select = false; // Revalidation never changes a selected product or hard constraint.
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        // The second transaction rechecks ownership, task/cart revisions and checkpoint CAS.
        self.propose_inner(cart, customer, draft, Some(expected))
            .await
    }
}

pub async fn stale(tx: &mut Tx<'_>, cart: Uuid, task: Uuid) -> Result<()> {
    if let Some(mut c) = load(tx, cart, task).await? {
        if !c.terminal() && c.receipt.state == State::AwaitingConfirmation {
            c.transition(State::NeedsInput)?;
            c.receipt.verdict = Verdict::Stale;
            c.receipt.reasons = vec!["revalidation_required".into()];
            save(tx, cart, &mut c).await?;
        }
    }
    Ok(())
}
