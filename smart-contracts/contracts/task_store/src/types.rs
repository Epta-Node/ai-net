use soroban_sdk::{contracterror, contracttype, Address, Bytes, BytesN, Symbol, Vec};

pub const DEFAULT_TTL_DAYS: u32 = 14;
pub const MAX_TTL_DAYS: u32 = 30;
pub const MAX_COMPRESSED_DAG_BYTES: u32 = 4 * 1024;
pub const LEDGERS_PER_DAY: u32 = 17_280;

/// Safety ceiling on the number of version records retained per task.
///
/// The lifecycle state machine admits at most six transitions from
/// `Created` (see `TaskStatus`), so a task can never hold more than seven
/// records. The bound sits just above that so that a future relaxation of the
/// transition table cannot silently turn `TaskHistory` into an unbounded
/// per-task vector.
pub const MAX_HISTORY_RECORDS: u32 = 8;

/// Maximum number of task ids retained in a single creator's index.
///
/// The per-creator index is a persistent vector, so it is bounded and
/// oldest-first eviction is used once the cap is reached. Reads are paginated
/// via `get_tasks_by_creator`.
pub const MAX_TRACKED_TASKS_PER_CREATOR: u32 = 64;

/// Largest `limit` accepted by `get_tasks_by_creator`; larger requests are
/// clamped so a single call cannot return an unbounded page.
pub const MAX_TASKS_PAGE_SIZE: u32 = 20;

/// Schema version stamped on every task lifecycle event payload (see
/// `docs/TASK_LIFECYCLE_EVENTS.md`). Bump only for a breaking payload
/// change; additive fields do not require a bump.
pub const TASK_LIFECYCLE_EVENT_VERSION: u32 = 1;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TaskStatus {
    /// The task exists but has not been offered to the network yet.
    Created = 0,
    /// The task is in the queue awaiting an agent.
    Queued = 1,
    /// At least one agent has been assigned to the task.
    Assigned = 2,
    /// An assigned agent is executing the task.
    Running = 3,
    /// Terminal: the task finished successfully.
    Completed = 4,
    /// Terminal: the task finished unsuccessfully.
    Failed = 5,
    /// Terminal: the task was called off before it completed.
    Cancelled = 6,
}

impl TaskStatus {
    /// A status no further transition may leave.
    ///
    /// Terminal states are absorbing: `Completed`, `Failed` and `Cancelled` all
    /// reject every outgoing transition with
    /// [`Error::InvalidStatusTransition`](crate::Error::InvalidStatusTransition).
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
        )
    }
}

/// Stored state for a single task submitted through the DAG-based
/// `store_task_metadata` entrypoint.
///
/// `quoted_price_stroops` is `None` when no OracleManager is configured at the
/// time the task was submitted.  When an OracleManager _is_ configured and
/// successfully returns a price, the value is stamped here at creation time so
/// that the agreed price is immutable for the lifetime of the task.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskMetadata {
    pub task_id: BytesN<32>,
    pub prompt_hash: BytesN<32>,
    pub assigned_agents: Vec<Address>,
    pub compressed_dag: Bytes,
    pub status: TaskStatus,
    pub created_at: u64,
    pub expires_at: u64,
    /// Oracle-quoted price in stroops, stamped at creation time.
    /// `None` if no OracleManager is configured.
    pub quoted_price_stroops: Option<i128>,
    /// Asset pair used to fetch the quoted price (e.g. `XLM_USD`).
    /// `None` when `quoted_price_stroops` is `None`.
    pub price_pair: Option<Symbol>,
}

/// Stored state for a single task submitted through the budget-based
/// `create_task` entrypoint.
///
/// This is the record returned by `get_task`, and the record the
/// `get_history` / `get_tasks_by_creator` audit-trail helpers are written
/// against. It carries no DAG and no assigned-agent list: assignment is a
/// status transition, and the addresses that drove each transition live in the
/// version history.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskRecord {
    pub task_id: BytesN<32>,
    /// Address that called `create_task`. Also the index key used by
    /// `get_tasks_by_creator`.
    pub creator: Address,
    /// SHA-256 of the prompt. The prompt itself is never stored on-chain.
    pub prompt_hash: BytesN<32>,
    /// Budget the creator committed to the task, in stroops
    /// (1 XLM = 10_000_000 stroops). Immutable after creation.
    pub budget_xlm: i128,
    pub status: TaskStatus,
    pub created_at: u64,
    /// Timestamp of the most recent accepted transition.
    pub updated_at: u64,
    /// Number of records in this task's version history. Starts at `1`, from the
    /// record written by `create_task`.
    pub version: u32,
}

/// A [`TaskRecord`] together with its complete version history, as returned by
/// `get_task`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskWithHistory {
    pub task: TaskRecord,
    /// Every status the task has ever held, oldest first. Same contents as
    /// `get_history(task_id)`.
    pub history: Vec<TaskVersionRecord>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address — the only address permitted to call `set_oracle_manager`.
    Admin,
    /// Contract version string.
    Version,
    /// Emergency-stop flag; `true` blocks all state-mutating entrypoints.
    Paused,
    /// Legacy task metadata keyed by task ID.
    Task(BytesN<32>),
    /// Lifecycle task record (with version-history support) keyed by task ID.
    LifecycleTask(BytesN<32>),
    /// Optional OracleManager contract address used to resolve quoted prices.
    OracleManager,
    /// Optional coordinator address, set by the admin.
    ///
    /// Alongside the task creator, this is the only role permitted to drive
    /// `update_status` transitions on another party's task.
    Coordinator,
    /// Address that created a task, keyed by task id.
    ///
    /// Held separately from [`DataKey::Task`] so the existing
    /// [`TaskMetadata`] storage layout is untouched by the version-history
    /// feature.
    TaskCreator(BytesN<32>),
    /// Append-only version history for a task, oldest record first.
    TaskHistory(BytesN<32>),
    /// Number of records currently held in [`DataKey::TaskHistory`].
    TaskVersionCount(BytesN<32>),
    /// Task ids created by an address, oldest first, bounded by
    /// [`MAX_TRACKED_TASKS_PER_CREATOR`].
    CreatorTasks(Address),
}

/// Emitted exactly once per successful `store_task_metadata` call, under
/// topics `(task_meta, created)`. See `docs/TASK_LIFECYCLE_EVENTS.md`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskCreatedEvent {
    pub version: u32,
    pub task_id: BytesN<32>,
    pub prompt_hash: BytesN<32>,
    pub assigned_agents: Vec<Address>,
    pub created_at: u64,
    pub expires_at: u64,
    /// Oracle-quoted price in stroops at the moment of task creation.
    /// `None` means no oracle was configured.
    pub quoted_price_stroops: Option<i128>,
}

/// Emitted for a successful non-terminal status transition, under topics
/// `(task_meta, updated)`. Terminal transitions (`-> Completed` / `-> Failed` /
/// `-> Cancelled`) emit [`TaskFinalizedEvent`] instead - never both - so each
/// transition emits exactly one lifecycle event. See
/// `docs/TASK_STORE_EVENTS.md`.
/// Emitted for a successful non-terminal status transition (e.g.
/// `Assigned -> Running`), under topics `(task_meta, updated)`. Terminal
/// transitions (`-> Completed` / `-> Failed` / `-> Cancelled`) emit
/// [`TaskFinalizedEvent`] instead, never both, so each transition emits exactly
/// one lifecycle event. See `docs/TASK_STORE_EVENTS.md`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskUpdatedEvent {
    pub version: u32,
    pub task_id: BytesN<32>,
    pub agent: Address,
    pub old_status: TaskStatus,
    pub new_status: TaskStatus,
    pub updated_at: u64,
}

/// Emitted for a successful transition into a terminal status (`Completed`,
/// `Failed` or `Cancelled`), under topics `(task_meta, finalized)`.
/// `final_status` is always one of those three values. See
/// `docs/TASK_STORE_EVENTS.md`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskFinalizedEvent {
    pub version: u32,
    pub task_id: BytesN<32>,
    pub agent: Address,
    pub old_status: TaskStatus,
    pub final_status: TaskStatus,
    pub finalized_at: u64,
}

/// Emitted exactly once per successful `create_task` call, under topics
/// `(task_life, created)`. See `docs/TASK_STORE_EVENTS.md`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LifecycleTaskCreatedEvent {
    pub version: u32,
    pub task_id: BytesN<32>,
    pub creator: Address,
    pub prompt_hash: BytesN<32>,
    /// Budget committed by the creator, in stroops.
    pub budget_xlm: i128,
    pub created_at: u64,
}

/// Emitted for every accepted `update_status` transition, under topics
/// `(task_life, status)`. Exactly one event per accepted transition, whether or
/// not the new status is terminal — a terminal transition is distinguishable by
/// `to_status.is_terminal()`. See `docs/TASK_STORE_EVENTS.md`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LifecycleStatusChangedEvent {
    pub version: u32,
    pub task_id: BytesN<32>,
    /// Version number of the history record this transition appended.
    pub record_version: u32,
    pub from_status: TaskStatus,
    pub to_status: TaskStatus,
    /// Creator for the creator-driven case, coordinator for the delegated one.
    pub updater: Address,
    pub updated_at: u64,
}

/// Emitted when the admin changes the coordinator address.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CoordinatorSetEvent {
    /// The new coordinator; `None` means it was cleared.
    pub coordinator: Option<Address>,
}

/// One immutable entry in a task's version history.
///
/// Records are append-only: an entry is never mutated or removed, and `seq` is
/// a monotonically increasing counter starting at `1` for the record written at
/// task creation. Reading the history in order therefore yields every status the
/// task has ever held, which is the audit trail this contract provides.
///
/// The history is keyed by task id alone, so `get_history` serves tasks created
/// through either `create_task` or `store_task_metadata`.
///
/// # Why there is no `tx_hash` here
///
/// A Soroban contract cannot read the hash of the transaction that invoked it:
/// the SDK exposes no host function for it (`Env::ledger()` provides only
/// `protocol_version`, `sequence`, `max_live_until_ledger`, `timestamp` and
/// `network_id`). Any hash stored on-chain would either have to be supplied and
/// signed by the caller — making it unverifiable and forgeable — or backfilled
/// later, which would make the "immutable" record mutable. Neither is
/// acceptable for an audit trail, so the field is omitted entirely.
///
/// Off-chain indexers should join these records against the `task_meta`
/// lifecycle events documented in `docs/TASK_STORE_EVENTS.md` and attach the
/// `tx_hash` of the transaction that emitted the matching event, which the
/// indexer observes directly from the ledger.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskVersionRecord {
    /// Monotonic sequence number, 1-based.
    pub seq: u32,
    /// Status the task held from this point forward.
    pub status: TaskStatus,
    /// Ledger timestamp of the transition.
    pub timestamp: u64,
    /// Ledger sequence number of the transition. Available on-chain, unlike a
    /// transaction hash, and uniquely orders records across tasks.
    pub ledger_sequence: u32,
    /// Address that produced the transition: the creator for the creation
    /// record, and the `agent` / `updater` of the call that caused it.
    pub updater: Address,
}

/// One page of a creator's task index, returned by `get_tasks_by_creator`.
///
/// The index is populated by both `create_task` and `store_task_metadata`, so a
/// creator sees every task they submitted through either path.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskPage {
    /// Task ids for this page, oldest first.
    pub task_ids: Vec<BytesN<32>>,
    /// Total number of task ids tracked for this creator, across all pages.
    pub total: u32,
    /// Cursor to pass as `cursor` to fetch the next page, or `None` once this
    /// is the final page.
    pub next_cursor: Option<u32>,
}

/// Emitted when the admin sets a new OracleManager address.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OracleManagerSetEvent {
    /// The new OracleManager contract address; `None` means it was cleared.
    pub oracle_manager: Option<Address>,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    AlreadyExists = 2,
    NoAssignedAgents = 3,
    DuplicateAgent = 4,
    InvalidDag = 5,
    InvalidTtl = 6,
    NotAssignedAgent = 7,
    InvalidStatusTransition = 8,
    Expired = 9,
    AlreadyInitialized = 10,
    NotInitialized = 11,
    Unauthorized = 12,
    UpgradeFailed = 13,
    /// The contract is paused and cannot accept mutations.
    ContractPaused = 14,
    /// OracleManager is configured but `price_pair` was not supplied.
    MissingPricePair = 15,
    /// OracleManager returned no usable price (stale feed + no fallback).
    OraclePriceUnavailable = 16,
    /// A batched request exceeded the maximum allowed size.
    BatchTooLarge = 17,
    /// The supplied budget/price value is invalid.
    InvalidBudget = 18,
    /// The caller is not an authorized updater for this task.
    NotAuthorizedUpdater = 19,
}
