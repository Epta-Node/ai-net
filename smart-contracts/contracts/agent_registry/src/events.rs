use soroban_sdk::{contracttype, Address, Symbol};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRegistered {
    pub agent_id: Symbol,
    pub agent_type: Symbol,
    pub owner: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentStatusChanged {
    pub agent_id: Symbol,
    pub old_status: Symbol,
    pub new_status: Symbol,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRemoved {
    pub agent_id: Symbol,
}
