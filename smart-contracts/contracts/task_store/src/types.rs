use soroban_sdk::{contracterror, contracttype, Address, Bytes, BytesN, Symbol, Vec};

pub const DEFAULT_TTL_DAYS: u32 = 14;
pub const MAX_TTL_DAYS: u32 = 30;
pub const MAX_COMPRESSED_DAG_BYTES: u32 = 4 * 1024;
pub const LEDGERS_PER_DAY: u32 = 17_280;

/// Schema version stamped on every task lifecycle event payload (see
/// `docs/TASK_LIFECYCLE_EVENTS.md`). Bump only for a breaking payload
/// change; additive fields do not require a bump.
pub const TASK_LIFECYCLE_EVENT_VERSION: u32 = 1;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TaskStatus {
    Pending = 0,
    Running = 1,
    Completed = 2,
    Failed = 3,
}

/// Stored state for a single task.
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

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Version,
    Task(BytesN<32>),
    /// Admin address — the only address permitted to call `set_oracle_manager`.
    Admin,
    /// Optional OracleManager contract address used to resolve quoted prices.
    OracleManager,
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

/// Emitted for a successful non-terminal status transition (currently only
/// `Pending -> Running`), under topics `(task_meta, updated)`. Terminal
/// transitions (`-> Completed` / `-> Failed`) emit [`TaskFinalizedEvent`]
/// instead — never both — so each transition emits exactly one lifecycle
/// event. See `docs/TASK_LIFECYCLE_EVENTS.md`.
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

/// Emitted for a successful transition into a terminal status (`Completed`
/// or `Failed`), under topics `(task_meta, finalized)`. `final_status` is
/// always one of those two values. See `docs/TASK_LIFECYCLE_EVENTS.md`.
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
}
