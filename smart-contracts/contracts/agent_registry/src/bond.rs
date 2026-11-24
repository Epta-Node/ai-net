//! Bond lifecycle storage and shared state transitions.

use crate::{AgentRecord, DataKey, Error, TTL_EXTEND_TO, TTL_THRESHOLD};
use soroban_sdk::{contracttype, Address, Env, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BondStatus {
    Active,
    Cooldown,
    Slashed,
    Returned,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondRecord {
    pub owner: Address,
    pub amount_stroops: i128,
    pub status: BondStatus,
    pub cooldown_until: Option<u32>,
}

pub fn initialize(env: &Env, agent: &AgentRecord) {
    let record = BondRecord {
        owner: agent.owner.clone(),
        amount_stroops: agent.bond_amount,
        status: BondStatus::Active,
        cooldown_until: None,
    };
    save(env, &agent.id, &record);
}

pub fn load(env: &Env, agent_id: &Symbol) -> Result<BondRecord, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Bond(agent_id.clone()))
        .ok_or(Error::NotFound)
}

pub fn save(env: &Env, agent_id: &Symbol, record: &BondRecord) {
    let key = DataKey::Bond(agent_id.clone());
    env.storage().persistent().set(&key, record);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn start_cooldown(env: &Env, agent_id: &Symbol, expiry_ledger: u32) -> Result<(), Error> {
    let mut record = load(env, agent_id)?;
    record.status = BondStatus::Cooldown;
    record.cooldown_until = Some(expiry_ledger);
    save(env, agent_id, &record);
    Ok(())
}

pub fn reward_pool(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::BondRewardPool)
        .unwrap_or(0)
}
