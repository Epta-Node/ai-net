use soroban_sdk::{contracterror, contracttype, Address, Bytes, BytesN, Vec};

pub const DEFAULT_TTL_DAYS: u32 = 90;
pub const MAX_TTL_DAYS: u32 = 365;
pub const MAX_COMPRESSED_DAG_BYTES: u32 = 8 * 1024;
pub const LEDGERS_PER_DAY: u32 = 17_280;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TaskStatus {
    Pending = 0,
    Running = 1,
    Completed = 2,
    Failed = 3,
}

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
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Version,
    Task(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskMetadataStored {
    pub task_id: BytesN<32>,
    pub prompt_hash: BytesN<32>,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskStatusUpdated {
    pub task_id: BytesN<32>,
    pub agent: Address,
    pub old_status: TaskStatus,
    pub new_status: TaskStatus,
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
