#![no_std]
//! # Error Registry (with TTL expiration and upgrade mechanism)

pub mod types;
pub use types::*;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Map,
    String, Symbol, Vec,
};

pub const MAX_TTL_SECONDS: u64 = 7_776_000;
pub const MAX_CLEANUP_BATCH: u32 = 100;
pub const DEFAULT_CLEANUP_BATCH: u32 = 50;
pub const CONTRACT_VERSION: &str = "1.0.0";

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    Version,
    LastUpgradeLedger,
    PreviousWasmHash,
    PreviousVersion,
    Record(BytesN<32>),
    CodeIndex(u32),
    AllErrorIds,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AlreadyExists = 1,
    InvalidTtl = 2,
    TtlOverflow = 3,
    ContractPaused = 4,
    AlreadyInitialized = 5,
    NotInitialized = 6,
    Unauthorized = 7,
    UpgradeFailed = 8,
    RollbackNotAvailable = 9,
}

#[contract]
pub struct ErrorRegistryContract;

fn read_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    admin.require_auth();
    Ok(admin)
}

fn require_not_paused(env: &Env) -> Result<(), Error> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        return Err(Error::ContractPaused);
    }
    Ok(())
}

#[contractimpl]
impl ErrorRegistryContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&DataKey::Version, &String::from_str(&env, CONTRACT_VERSION));

        env.events()
            .publish((symbol_short!("errreg"), symbol_short!("init")), admin);
        Ok(())
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn pause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((symbol_short!("errreg"), symbol_short!("paused")), ());
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((symbol_short!("errreg"), symbol_short!("unpaused")), ());
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Return the deployed contract version.
    pub fn contract_version(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or_else(|| String::from_str(&env, CONTRACT_VERSION))
    }

    /// Upgrade this contract's WASM. Only the admin may call this.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, new_version: String) -> Result<(), Error> {
        let desc = String::from_str(&env, "Direct upgrade");
        Self::upgrade_contract(env, new_wasm_hash, new_version, desc)
    }

    pub fn pre_upgrade_hook(
        env: Env,
        new_version: String,
        _new_wasm_hash: BytesN<32>,
    ) -> Result<Vec<String>, Error> {
        let mut results = Vec::new(&env);
        if Self::is_paused(env.clone()) {
            results.push_back(String::from_str(&env, "Contract is paused"));
            return Err(Error::ContractPaused);
        }
        results.push_back(String::from_str(&env, "Pre-upgrade validation successful"));
        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("pre_hook")),
            (new_version, true),
        );
        Ok(results)
    }

    pub fn post_upgrade_hook(
        env: Env,
        old_version: String,
        new_version: String,
    ) -> Result<(), Error> {
        env.storage()
            .instance()
            .set(&DataKey::Version, &new_version);
        env.storage()
            .instance()
            .set(&DataKey::LastUpgradeLedger, &env.ledger().sequence());

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("post_hook")),
            (old_version, new_version, true),
        );
        Ok(())
    }

    pub fn upgrade_contract(
        env: Env,
        new_wasm_hash: BytesN<32>,
        new_version: String,
        _description: String,
    ) -> Result<(), Error> {
        let admin = require_admin(&env)?;
        let old_version = Self::contract_version(env.clone());

        Self::pre_upgrade_hook(env.clone(), new_version.clone(), new_wasm_hash.clone())?;

        env.storage()
            .instance()
            .set(&DataKey::PreviousVersion, &old_version);

        #[cfg(all(target_arch = "wasm32", not(any(test, feature = "testutils"))))]
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());

        Self::post_upgrade_hook(env.clone(), old_version.clone(), new_version.clone())?;

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("proposed")),
            (
                env.current_contract_address(),
                old_version.clone(),
                new_version.clone(),
                new_wasm_hash.clone(),
                admin.clone(),
            ),
        );

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("applied")),
            (
                env.current_contract_address(),
                old_version,
                new_version,
                new_wasm_hash,
                admin,
                env.ledger().sequence(),
            ),
        );

        Ok(())
    }

    pub fn emergency_rollback(
        env: Env,
        _rollback_wasm_hash: BytesN<32>,
        rollback_version: String,
    ) -> Result<(), Error> {
        let admin = require_admin(&env)?;

        let last_upgrade: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LastUpgradeLedger)
            .unwrap_or(0);
        let current_ledger = env.ledger().sequence();
        if last_upgrade == 0 || current_ledger > last_upgrade + 34_560 {
            return Err(Error::RollbackNotAvailable);
        }

        let current_version = Self::contract_version(env.clone());

        #[cfg(all(target_arch = "wasm32", not(any(test, feature = "testutils"))))]
        env.deployer()
            .update_current_contract_wasm(_rollback_wasm_hash);

        env.storage()
            .instance()
            .set(&DataKey::Version, &rollback_version);
        env.storage().instance().remove(&DataKey::LastUpgradeLedger);

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("rollback")),
            (
                env.current_contract_address(),
                current_version,
                rollback_version,
                admin,
                env.ledger().sequence(),
            ),
        );

        Ok(())
    }

    pub fn estimate_migration_gas(_env: Env, _target_version: String) -> u64 {
        50_000
    }

    pub fn submit_error(
        env: Env,
        error_id: BytesN<32>,
        error_code: u32,
        message: Symbol,
        agent_id: Symbol,
        ttl_seconds: u64,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        validate_ttl(ttl_seconds)?;

        let error_key = DataKey::Record(error_id.clone());
        if env.storage().persistent().has(&error_key) {
            return Err(Error::AlreadyExists);
        }

        let created_at = env.ledger().timestamp();
        let expires_at = created_at
            .checked_add(ttl_seconds)
            .ok_or(Error::TtlOverflow)?;

        let record = ErrorRecord {
            error_code,
            message,
            agent_id,
            created_at,
            expires_at,
        };

        let code_key = DataKey::CodeIndex(error_code);
        let mut code_ids: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&code_key)
            .unwrap_or_else(|| Vec::new(&env));
        if code_ids.len() >= MAX_CODE_INDEX_SIZE {
            return Err(Error::MaxCapacityReached);
        }
        code_ids.push_back(error_id.clone());
        env.storage().persistent().set(&code_key, &code_ids);
        env.storage()
            .persistent()
            .extend_ttl(&code_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        let mut all_ids: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::AllErrorIds)
            .unwrap_or_else(|| Vec::new(&env));
        all_ids.push_back(error_id.clone());
        env.storage()
            .persistent()
            .set(&DataKey::AllErrorIds, &all_ids);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::AllErrorIds, TTL_THRESHOLD, TTL_EXTEND_TO);

        env.storage().persistent().set(&error_key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&error_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        env.events().publish(
            (symbol_short!("errreg"), symbol_short!("submitted")),
            (error_id, error_code, expires_at),
        );

        Ok(())
    }

    pub fn get_error(env: Env, error_id: BytesN<32>) -> Option<ErrorRecord> {
        let now = env.ledger().timestamp();
        let key = DataKey::Record(error_id);
        if env.storage().persistent().has(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
        env.storage()
            .persistent()
            .get(&DataKey::Record(error_id))
            .filter(|record: &ErrorRecord| is_active(now, record))
    }

    pub fn get_errors_by_code(env: Env, error_code: u32) -> Vec<ErrorRecord> {
        let now = env.ledger().timestamp();
        let ids = read_code_index(&env, error_code);

        let mut records = Vec::new(&env);
        for id in ids.iter() {
            if let Some(record) = env.storage().persistent().get(&DataKey::Record(id)) {
                if is_active(now, &record) {
                    records.push_back(record);
                }
            }
        }
        records
    }

    pub fn count_active_by_code(env: Env, error_code: u32) -> u32 {
        Self::get_errors_by_code(env, error_code).len()
    }

    pub fn cleanup_expired_errors(env: Env, max_batch: u32) -> CleanupStats {
        let now = env.ledger().timestamp();
        let batch = resolve_batch(max_batch);

        let all_ids: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::AllErrorIds)
            .unwrap_or_else(|| Vec::new(&env));

        let mut kept_ids = Vec::new(&env);
        let mut removed_by_code: Map<u32, Vec<BytesN<32>>> = Map::new(&env);
        let mut scanned: u32 = 0;
        let mut removed: u32 = 0;

        for id in all_ids.iter() {
            if removed >= batch {
                kept_ids.push_back(id);
                continue;
            }

            scanned += 1;
            let error_key = DataKey::Record(id.clone());
            match env.storage().persistent().get(&error_key) {
                Some(record) if is_active(now, &record) => {
                    kept_ids.push_back(id);
                }
                Some(record) => {
                    env.storage().persistent().remove(&error_key);
                    let mut ids = removed_by_code
                        .get(record.error_code)
                        .unwrap_or_else(|| Vec::new(&env));
                    ids.push_back(id.clone());
                    removed_by_code.set(record.error_code, ids);
                    removed += 1;
                }
                None => {
                    removed += 1;
                }
            }
        }

        apply_code_index_removals(&env, &removed_by_code);

        if kept_ids.is_empty() {
            env.storage().persistent().remove(&DataKey::AllErrorIds);
        } else {
            env.storage()
                .persistent()
                .set(&DataKey::AllErrorIds, &kept_ids);
        }

        let stats = CleanupStats {
            scanned,
            removed,
            remaining: kept_ids.len(),
        };

        if removed > 0 {
            env.events().publish(
                (symbol_short!("errreg"), symbol_short!("cleaned")),
                stats.clone(),
            );
        }

        stats
    }
}

fn validate_ttl(ttl_seconds: u64) -> Result<(), Error> {
    if ttl_seconds == 0 || ttl_seconds > MAX_TTL_SECONDS {
        return Err(Error::InvalidTtl);
    }
    Ok(())
}

fn is_active(now: u64, record: &ErrorRecord) -> bool {
    now <= record.expires_at
}

fn resolve_batch(max_batch: u32) -> u32 {
    match max_batch {
        0 => DEFAULT_CLEANUP_BATCH,
        n if n > MAX_CLEANUP_BATCH => MAX_CLEANUP_BATCH,
        n => n,
    }
}

fn read_code_index(env: &Env, error_code: u32) -> Vec<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&DataKey::CodeIndex(error_code))
        .unwrap_or_else(|| Vec::new(env))
}

fn apply_code_index_removals(env: &Env, removed_by_code: &Map<u32, Vec<BytesN<32>>>) {
    for code in removed_by_code.keys().iter() {
        let to_remove = removed_by_code.get(code).unwrap_or_else(|| Vec::new(env));
        let current = read_code_index(env, code);

        let mut updated = Vec::new(env);
        for id in current.iter() {
            if !vec_contains(&to_remove, &id) {
                updated.push_back(id);
            }
        }

        let code_key = DataKey::CodeIndex(code);
        if updated.is_empty() {
            env.storage().persistent().remove(&code_key);
        } else {
            env.storage().persistent().set(&code_key, &updated);
        }
    }
}

fn vec_contains(list: &Vec<BytesN<32>>, target: &BytesN<32>) -> bool {
    for item in list.iter() {
        if &item == target {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod test;
