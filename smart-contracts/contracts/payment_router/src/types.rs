use soroban_sdk::{contracterror, contractimpl, contracttype, Address, Env, Map, Symbol, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub coordinator: Address,
    pub token: Address,
    pub total_amount: i128,
    pub amounts: Map<Address, i128>,
    pub deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Escrow(u64), // Task ID
}
