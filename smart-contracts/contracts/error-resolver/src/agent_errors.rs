use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
};

/// On-chain per-agent error ledger. Distinct from the off-chain
/// `ErrorResolver` lookup table (see `lookup.rs`): this contract tracks how
/// many errors have been reported for a given agent, so `agent-registry` can
/// cascade cleanup on removal and surface error counts in health queries.
#[contracttype]
pub enum DataKey {
    Admin,
    AuthorizedCallers,
    AgentErrorCount(Symbol),
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ContractError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
}

#[contract]
pub struct ErrorResolverContract;

fn require_admin(env: &Env) -> Result<Address, ContractError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ContractError::NotInitialized)?;
    admin.require_auth();
    Ok(admin)
}

/// Authorizes a cross-contract caller against the allowlist.
///
/// `caller.require_auth()` proves the address is genuinely the direct
/// invoker of this call (a contract auto-satisfies auth for its own address
/// when it is the one making the call, the same mechanism `agent-registry`
/// relies on when it invokes this contract). The allowlist check on top of
/// that is the actual permission gate: proving identity isn't enough, the
/// caller must also be a contract this instance was configured to trust.
fn require_authorized_caller(env: &Env, caller: &Address) -> Result<(), ContractError> {
    caller.require_auth();
    let allowlist: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::AuthorizedCallers)
        .unwrap_or_else(|| Vec::new(env));
    if allowlist.contains(caller) {
        Ok(())
    } else {
        Err(ContractError::Unauthorized)
    }
}

#[contractimpl]
impl ErrorResolverContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &Vec::<Address>::new(&env));
        Ok(())
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Allowlists a contract address (e.g. agent-registry) to call
    /// `record_error` and `clear_agent_errors`. Admin only.
    pub fn add_authorized_caller(env: Env, caller: Address) -> Result<(), ContractError> {
        require_admin(&env)?;
        let mut allowlist: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AuthorizedCallers)
            .unwrap_or_else(|| Vec::new(&env));
        if !allowlist.contains(&caller) {
            allowlist.push_back(caller.clone());
            env.storage()
                .instance()
                .set(&DataKey::AuthorizedCallers, &allowlist);
        }
        env.events().publish(
            (symbol_short!("errres"), symbol_short!("caller_ok")),
            caller,
        );
        Ok(())
    }

    /// Revokes a previously allowlisted caller. Admin only.
    pub fn remove_authorized_caller(env: Env, caller: Address) -> Result<(), ContractError> {
        require_admin(&env)?;
        let allowlist: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AuthorizedCallers)
            .unwrap_or_else(|| Vec::new(&env));
        let mut updated = Vec::new(&env);
        for c in allowlist.iter() {
            if c != caller {
                updated.push_back(c);
            }
        }
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &updated);
        env.events().publish(
            (symbol_short!("errres"), symbol_short!("caller_rm")),
            caller,
        );
        Ok(())
    }

    pub fn is_authorized_caller(env: Env, caller: Address) -> bool {
        let allowlist: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::AuthorizedCallers)
            .unwrap_or_else(|| Vec::new(&env));
        allowlist.contains(&caller)
    }

    /// Records an error occurrence for `agent_id`. `caller` must be an
    /// allowlisted contract (see `add_authorized_caller`) and must be the
    /// genuine direct invoker of this call.
    pub fn record_error(env: Env, caller: Address, agent_id: Symbol) -> Result<u32, ContractError> {
        require_authorized_caller(&env, &caller)?;
        let key = DataKey::AgentErrorCount(agent_id.clone());
        let count: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_count = count.saturating_add(1);
        env.storage().persistent().set(&key, &new_count);
        env.events().publish(
            (symbol_short!("errres"), symbol_short!("recorded")),
            (agent_id, new_count),
        );
        Ok(new_count)
    }

    /// Read-only: number of errors on record for `agent_id`, 0 if none.
    pub fn get_agent_error_count(env: Env, agent_id: Symbol) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::AgentErrorCount(agent_id))
            .unwrap_or(0)
    }

    /// Clears the error ledger for `agent_id`. `caller` must be an
    /// allowlisted contract. This is what `agent-registry` calls when an
    /// agent is deregistered, so errors don't outlive the agent record.
    pub fn clear_agent_errors(
        env: Env,
        caller: Address,
        agent_id: Symbol,
    ) -> Result<(), ContractError> {
        require_authorized_caller(&env, &caller)?;
        env.storage()
            .persistent()
            .remove(&DataKey::AgentErrorCount(agent_id.clone()));
        env.events().publish(
            (symbol_short!("errres"), symbol_short!("cleared")),
            agent_id,
        );
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, ErrorResolverContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ErrorResolverContract, ());
        let client = ErrorResolverContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    #[test]
    fn initialize_sets_admin() {
        let (env, client, admin) = setup();
        assert_eq!(client.get_admin(), Some(admin));
        let _ = env;
    }

    #[test]
    fn initialize_cannot_run_twice() {
        let (env, client, _admin) = setup();
        let result = client.try_initialize(&Address::generate(&env));
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn admin_can_manage_allowlist() {
        let (env, client, _admin) = setup();
        let registry = Address::generate(&env);
        assert!(!client.is_authorized_caller(&registry));

        client.add_authorized_caller(&registry);
        assert!(client.is_authorized_caller(&registry));

        client.remove_authorized_caller(&registry);
        assert!(!client.is_authorized_caller(&registry));
    }

    #[test]
    fn non_admin_cannot_manage_allowlist() {
        let env = Env::default();
        let id = env.register(ErrorResolverContract, ());
        let client = ErrorResolverContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        env.mock_all_auths();
        client.initialize(&admin);

        env.mock_auths(&[]);
        let registry = Address::generate(&env);
        let result = client.try_add_authorized_caller(&registry);
        assert!(result.is_err());
    }

    #[test]
    fn record_and_query_error_count() {
        let (env, client, _admin) = setup();
        let registry = Address::generate(&env);
        client.add_authorized_caller(&registry);
        let agent_id = Symbol::new(&env, "agent1");

        assert_eq!(client.get_agent_error_count(&agent_id), 0);
        client.record_error(&registry, &agent_id);
        client.record_error(&registry, &agent_id);
        assert_eq!(client.get_agent_error_count(&agent_id), 2);
    }

    #[test]
    fn clear_resets_count_to_zero() {
        let (env, client, _admin) = setup();
        let registry = Address::generate(&env);
        client.add_authorized_caller(&registry);
        let agent_id = Symbol::new(&env, "agent2");

        client.record_error(&registry, &agent_id);
        client.record_error(&registry, &agent_id);
        assert_eq!(client.get_agent_error_count(&agent_id), 2);

        client.clear_agent_errors(&registry, &agent_id);
        assert_eq!(client.get_agent_error_count(&agent_id), 0);
    }

    #[test]
    fn unauthorized_caller_cannot_record() {
        let (env, client, _admin) = setup();
        let stranger = Address::generate(&env);
        let agent_id = Symbol::new(&env, "agent3");

        let result = client.try_record_error(&stranger, &agent_id);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn unauthorized_caller_cannot_clear() {
        let (env, client, _admin) = setup();
        let stranger = Address::generate(&env);
        let agent_id = Symbol::new(&env, "agent4");

        let result = client.try_clear_agent_errors(&stranger, &agent_id);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn error_count_for_unknown_agent_is_zero() {
        let (env, client, _admin) = setup();
        let agent_id = Symbol::new(&env, "ghost");
        assert_eq!(client.get_agent_error_count(&agent_id), 0);
    }
}
