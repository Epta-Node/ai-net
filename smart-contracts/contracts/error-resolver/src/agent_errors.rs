use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    Symbol, Vec,
};

const CONTRACT_VERSION: &str = "1.0.0";

/// On-chain per-agent error ledger. Distinct from the off-chain
/// `ErrorResolver` lookup table (see `lookup.rs`): this contract tracks how
/// many errors have been reported for a given agent, so `agent-registry` can
/// cascade cleanup on removal and surface error counts in health queries.
#[contracttype]
pub enum DataKey {
    Admin,
<<<<<<< HEAD
    Paused,
=======
    Version,
>>>>>>> 2df3e3b3a809dfb3562e65cb0d42cb71b77b6d25
    AuthorizedCallers,
    AgentErrorCount(Symbol),
    Signers,
    Quorum,
    PendingOps,
    AuditLog,
}

/// A pending allowlist operation awaiting quorum approvals.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingOp {
    /// Unique operation ID, computed at proposal time.
    pub op_id: BytesN<32>,
    /// "add" or "remove" — the type of allowlist mutation.
    pub op_type: Symbol,
    /// The target address to add/remove from the allowlist.
    pub target: Address,
    /// Addresses that have approved this operation.
    pub approvals: Vec<Address>,
    /// Ledger timestamp when the proposal was created.
    pub created_at: u64,
    /// Earliest ledger timestamp at which this op may be executed.
    pub execute_after: u64,
}

/// An immutable audit log entry recording an allowlist mutation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditEntry {
    /// Address that performed the action (or the proposer for multisig ops).
    pub actor: Address,
    /// Short symbol describing the operation (e.g. "add_caller").
    pub op: Symbol,
    /// Target address affected by the operation.
    pub target: Address,
    /// Ledger timestamp of the action.
    pub timestamp: u64,
}

/// Default timelock in ledger seconds (24 hours).
pub const DEFAULT_TIMELOCK: u64 = 86_400;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ContractError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
<<<<<<< HEAD
    ContractPaused = 4,
=======
    QuorumNotMet = 4,
    TimelockNotExpired = 5,
    AlreadyApproved = 6,
    OpNotFound = 7,
    SignerNotFound = 8,
>>>>>>> 2df3e3b3a809dfb3562e65cb0d42cb71b77b6d25
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

fn require_not_paused(env: &Env) -> Result<(), ContractError> {
    let paused: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        return Err(ContractError::ContractPaused);
    }
    Ok(())
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

/// Returns Ok if the address is a signer and requires auth.
fn require_signer(env: &Env, addr: &Address) -> Result<(), ContractError> {
    let signers: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::Signers)
        .unwrap_or_else(|| Vec::new(env));
    if signers.contains(addr) {
        addr.require_auth();
        Ok(())
    } else {
        Err(ContractError::Unauthorized)
    }
}

/// Deterministic ID for a pending op using a sequential nonce stored on-chain.
fn next_op_id(env: &Env) -> BytesN<32> {
    let nonce_key = DataKey::AgentErrorCount(Symbol::new(env, "__op_nonce"));
    let nonce: u32 = env.storage().persistent().get(&nonce_key).unwrap_or(0);
    env.storage()
        .persistent()
        .set(&nonce_key, &nonce.saturating_add(1));
    let mut buf = soroban_sdk::Bytes::new(env);
    buf.extend_from_slice(&nonce.to_be_bytes());
    buf.extend_from_slice(&env.ledger().timestamp().to_be_bytes());
    env.crypto().sha256(&buf).into()
}

/// Apply an executed pending op to the allowlist.
fn apply_allowlist_op(env: &Env, op: &PendingOp) -> Result<(), ContractError> {
    let mut allowlist: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::AuthorizedCallers)
        .unwrap_or_else(|| Vec::new(env));
    if op.op_type == symbol_short!("add") {
        if !allowlist.contains(&op.target) {
            allowlist.push_back(op.target.clone());
        }
    } else {
        let mut updated = Vec::new(&env);
        for c in allowlist.iter() {
            if c != op.target {
                updated.push_back(c);
            }
        }
        allowlist = updated;
    }
    env.storage()
        .instance()
        .set(&DataKey::AuthorizedCallers, &allowlist);
    Ok(())
}

/// Append an audit entry and emit an audit event.
fn record_audit(env: &Env, actor: &Address, op: Symbol, target: &Address) {
    let entry = AuditEntry {
        actor: actor.clone(),
        op: op.clone(),
        target: target.clone(),
        timestamp: env.ledger().timestamp(),
    };
    let mut log: Vec<AuditEntry> = env
        .storage()
        .instance()
        .get(&DataKey::AuditLog)
        .unwrap_or_else(|| Vec::new(env));
    log.push_back(entry);
    env.storage().instance().set(&DataKey::AuditLog, &log);
    env.events().publish(
        (symbol_short!("errres"), symbol_short!("audit")),
        (actor.clone(), op, target.clone(), env.ledger().timestamp()),
    );
}

#[contractimpl]
impl ErrorResolverContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&DataKey::Version, &String::from_str(&env, CONTRACT_VERSION));
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &Vec::<Address>::new(&env));
<<<<<<< HEAD
        env.events()
            .publish((symbol_short!("errres"), symbol_short!("init")), admin);
=======
        let mut signers = Vec::<Address>::new(&env);
        signers.push_back(admin.clone());
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage().instance().set(&DataKey::Quorum, &1u32);
        env.storage()
            .instance()
            .set(&DataKey::PendingOps, &Vec::<PendingOp>::new(&env));
        env.storage()
            .instance()
            .set(&DataKey::AuditLog, &Vec::<AuditEntry>::new(&env));
>>>>>>> 2df3e3b3a809dfb3562e65cb0d42cb71b77b6d25
        Ok(())
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

<<<<<<< HEAD
    /// Pause the contract. Only admin can call this.
    pub fn pause(env: Env) -> Result<(), ContractError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((symbol_short!("errres"), symbol_short!("paused")), ());
        Ok(())
    }

    /// Unpause the contract. Only admin can call this.
    pub fn unpause(env: Env) -> Result<(), ContractError> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((symbol_short!("errres"), symbol_short!("unpaused")), ());
        Ok(())
    }

    /// Returns whether the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
=======
    pub fn get_quorum(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Quorum).unwrap_or(1)
    }

    pub fn get_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn get_audit_log(env: Env) -> Vec<AuditEntry> {
        env.storage()
            .instance()
            .get(&DataKey::AuditLog)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn get_pending_op(env: Env, op_id: BytesN<32>) -> Option<PendingOp> {
        let ops: Vec<PendingOp> = env
            .storage()
            .instance()
            .get(&DataKey::PendingOps)
            .unwrap_or_else(|| Vec::new(&env));
        for op in ops.iter() {
            if op.op_id == op_id {
                return Some(op);
            }
        }
        None
    }

    /// Sets the quorum threshold. Only the admin can call this.
    pub fn set_quorum(env: Env, new_quorum: u32) -> Result<(), ContractError> {
        let admin = require_admin(&env)?;
        let signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env));
        if new_quorum == 0 || new_quorum > signers.len() {
            return Err(ContractError::QuorumNotMet);
        }
        env.storage().instance().set(&DataKey::Quorum, &new_quorum);
        record_audit(&env, &admin, symbol_short!("set_qrm"), &admin);
        Ok(())
    }

    /// Adds a signer. The caller must be an existing signer.
    pub fn add_signer(env: Env, proposer: Address, signer: Address) -> Result<(), ContractError> {
        require_signer(&env, &proposer)?;
        let mut signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env));
        if !signers.contains(&signer) {
            signers.push_back(signer.clone());
            env.storage().instance().set(&DataKey::Signers, &signers);
        }
        record_audit(&env, &proposer, symbol_short!("add_sgnr"), &signer);
        Ok(())
    }

    /// Removes a signer. The caller must be an existing signer. Quorum
    /// must not exceed the remaining signer count.
    pub fn remove_signer(
        env: Env,
        proposer: Address,
        signer: Address,
    ) -> Result<(), ContractError> {
        require_signer(&env, &proposer)?;
        let signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env));
        let mut updated = Vec::new(&env);
        for s in signers.iter() {
            if s != signer {
                updated.push_back(s);
            }
        }
        let quorum: u32 = env.storage().instance().get(&DataKey::Quorum).unwrap_or(1);
        if updated.is_empty() || quorum > updated.len() {
            return Err(ContractError::QuorumNotMet);
        }
        env.storage().instance().set(&DataKey::Signers, &updated);
        record_audit(&env, &proposer, symbol_short!("rm_signer"), &signer);
        Ok(())
    }

    /// Proposes an allowlist add/remove operation with a timelock.
    /// The proposer must be a signer. Returns the operation ID.
    pub fn propose_allowlist_op(
        env: Env,
        proposer: Address,
        op_type: Symbol,
        target: Address,
    ) -> Result<BytesN<32>, ContractError> {
        require_signer(&env, &proposer)?;
        let now = env.ledger().timestamp();
        let op_id = next_op_id(&env);
        let mut approvals = Vec::<Address>::new(&env);
        approvals.push_back(proposer.clone());
        let pending = PendingOp {
            op_id: op_id.clone(),
            op_type,
            target: target.clone(),
            approvals,
            created_at: now,
            execute_after: now + DEFAULT_TIMELOCK,
        };
        let mut ops: Vec<PendingOp> = env
            .storage()
            .instance()
            .get(&DataKey::PendingOps)
            .unwrap_or_else(|| Vec::new(&env));
        ops.push_back(pending);
        env.storage().instance().set(&DataKey::PendingOps, &ops);
        record_audit(&env, &proposer, symbol_short!("propose"), &target);
        Ok(op_id)
    }

    /// Approves a pending allowlist operation. The approver must be a signer
    /// who hasn't already approved this operation.
    pub fn approve_allowlist_op(
        env: Env,
        approver: Address,
        op_id: BytesN<32>,
    ) -> Result<(), ContractError> {
        require_signer(&env, &approver)?;
        let mut ops: Vec<PendingOp> = env
            .storage()
            .instance()
            .get(&DataKey::PendingOps)
            .unwrap_or_else(|| Vec::new(&env));
        let mut found = false;
        for i in 0..ops.len() {
            let op = ops.get(i).unwrap();
            if op.op_id == op_id {
                if op.approvals.contains(&approver) {
                    return Err(ContractError::AlreadyApproved);
                }
                let mut updated_op = op.clone();
                updated_op.approvals.push_back(approver.clone());
                ops.set(i, updated_op);
                found = true;
                break;
            }
        }
        if !found {
            return Err(ContractError::OpNotFound);
        }
        env.storage().instance().set(&DataKey::PendingOps, &ops);
        Ok(())
    }

    /// Executes a pending allowlist operation after quorum is met and
    /// timelock has expired. Removes the op from the pending list.
    pub fn execute_allowlist_op(
        env: Env,
        executor: Address,
        op_id: BytesN<32>,
    ) -> Result<(), ContractError> {
        require_signer(&env, &executor)?;
        let now = env.ledger().timestamp();
        let quorum: u32 = env.storage().instance().get(&DataKey::Quorum).unwrap_or(1);
        let ops: Vec<PendingOp> = env
            .storage()
            .instance()
            .get(&DataKey::PendingOps)
            .unwrap_or_else(|| Vec::new(&env));
        let mut executed_op: Option<PendingOp> = None;
        let mut remaining = Vec::<PendingOp>::new(&env);
        for i in 0..ops.len() {
            let op = ops.get(i).unwrap();
            if op.op_id == op_id {
                if op.approvals.len() < quorum {
                    return Err(ContractError::QuorumNotMet);
                }
                if now < op.execute_after {
                    return Err(ContractError::TimelockNotExpired);
                }
                executed_op = Some(op.clone());
            } else {
                remaining.push_back(op);
            }
        }
        let op = executed_op.ok_or(ContractError::OpNotFound)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingOps, &remaining);
        apply_allowlist_op(&env, &op)?;
        let audit_op = if op.op_type == symbol_short!("add") {
            symbol_short!("add_call")
        } else {
            symbol_short!("rm_caller")
        };
        record_audit(&env, &executor, audit_op, &op.target);
        Ok(())
>>>>>>> 2df3e3b3a809dfb3562e65cb0d42cb71b77b6d25
    }

    /// Allowlists a contract address (e.g. agent-registry) to call
    /// `record_error` and `clear_agent_errors`. Admin only.
    pub fn add_authorized_caller(env: Env, caller: Address) -> Result<(), ContractError> {
        require_not_paused(&env)?;
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
        record_audit(&env, &caller, symbol_short!("caller_ok"), &caller);
        Ok(())
    }

    /// Revokes a previously allowlisted caller. Admin only.
    pub fn remove_authorized_caller(env: Env, caller: Address) -> Result<(), ContractError> {
        require_not_paused(&env)?;
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
        record_audit(&env, &caller, symbol_short!("caller_rm"), &caller);
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
        require_not_paused(&env)?;
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
        require_not_paused(&env)?;
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
    use soroban_sdk::testutils::Ledger as _;

    fn setup() -> (Env, ErrorResolverContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(ErrorResolverContract, ());
        let client = ErrorResolverContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    fn setup_with_two_signers() -> (Env, ErrorResolverContractClient<'static>, Address, Address) {
        let (env, client, admin) = setup();
        let signer2 = Address::generate(&env);
        client.add_signer(&admin, &signer2);
        (env, client, admin, signer2)
    }

    #[test]
    fn initialize_sets_admin_and_signer() {
        let (_env, client, admin) = setup();
        assert_eq!(client.get_admin(), Some(admin.clone()));
        let signers = client.get_signers();
        assert_eq!(signers.len(), 1);
        assert_eq!(signers.get(0), Some(admin));
        assert_eq!(client.get_quorum(), 1);
    }

    #[test]
    fn initialize_cannot_run_twice() {
        let (env, client, _admin) = setup();
        let result = client.try_initialize(&Address::generate(&env));
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn admin_can_manage_allowlist_directly() {
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
    fn signer_can_add_and_remove_other_signers() {
        let (env, client, admin, _signer2) = setup_with_two_signers();
        let signer3 = Address::generate(&env);

        client.add_signer(&admin, &signer3);
        let signers = client.get_signers();
        assert_eq!(signers.len(), 3);

        client.remove_signer(&admin, &signer3);
        let signers = client.get_signers();
        assert_eq!(signers.len(), 2);
    }

    #[test]
    fn non_signer_cannot_add_signer() {
        let (env, client, _admin) = setup();
        let stranger = Address::generate(&env);
        let new_signer = Address::generate(&env);

        let result = client.try_add_signer(&stranger, &new_signer);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn set_quorum_works() {
        let (_env, client, _admin) = setup();
        client.set_quorum(&1);
        assert_eq!(client.get_quorum(), 1);
    }

    #[test]
    fn propose_and_execute_add_caller_single_quorum() {
        let (env, client, admin) = setup();
        let registry = Address::generate(&env);

        let op_id = client.propose_allowlist_op(&admin, &symbol_short!("add"), &registry);

        // Quorum is 1, proposer auto-approves, so execute should work after timelock
        env.ledger().set_timestamp(DEFAULT_TIMELOCK + 1);
        client.execute_allowlist_op(&admin, &op_id);
        assert!(client.is_authorized_caller(&registry));
    }

    #[test]
    fn execute_fails_before_timelock() {
        let (env, client, admin) = setup();
        let registry = Address::generate(&env);

        let op_id = client.propose_allowlist_op(&admin, &symbol_short!("add"), &registry);

        let result = client.try_execute_allowlist_op(&admin, &op_id);
        assert_eq!(result, Err(Ok(ContractError::TimelockNotExpired)));
    }

    #[test]
    fn approve_and_execute_multisig() {
        let (env, client, admin, _signer2) = setup_with_two_signers();
        let registry = Address::generate(&env);

        client.set_quorum(&2);

        let op_id = client.propose_allowlist_op(&admin, &symbol_short!("add"), &registry);

        // Only proposer approved (1), need 2
        env.ledger().set_timestamp(DEFAULT_TIMELOCK + 1);
        let result = client.try_execute_allowlist_op(&admin, &op_id);
        assert_eq!(result, Err(Ok(ContractError::QuorumNotMet)));
    }

    #[test]
    fn cannot_approve_twice() {
        let (env, client, admin, _signer2) = setup_with_two_signers();
        let registry = Address::generate(&env);

        let op_id = client.propose_allowlist_op(&admin, &symbol_short!("add"), &registry);

        let result = client.try_approve_allowlist_op(&admin, &op_id);
        assert_eq!(result, Err(Ok(ContractError::AlreadyApproved)));
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
    fn error_count_for_unknown_agent_is_zero() {
        let (env, client, _admin) = setup();
        let agent_id = Symbol::new(&env, "ghost");
        assert_eq!(client.get_agent_error_count(&agent_id), 0);
    }

<<<<<<< HEAD
    // ── Pause / unpause ───────────────────────────────────────────────────

    #[test]
    fn initialize_sets_unpaused() {
        let (env, client, _admin) = setup();
        assert!(!client.is_paused());
        let _ = env;
    }

    #[test]
    fn pause_blocks_record_error() {
        let (env, client, _admin) = setup();
        let registry = Address::generate(&env);
        client.add_authorized_caller(&registry);
        let agent_id = Symbol::new(&env, "agent5");

        client.pause();

        let result = client.try_record_error(&registry, &agent_id);
        assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
    }

    #[test]
    fn unpause_allows_record_error() {
        let (env, client, _admin) = setup();
        let registry = Address::generate(&env);
        client.add_authorized_caller(&registry);
        let agent_id = Symbol::new(&env, "agent6");

        client.pause();
        client.unpause();

        let count = client.record_error(&registry, &agent_id);
        assert_eq!(count, 1);
    }

    #[test]
    fn get_agent_error_count_still_works_when_paused() {
        let (env, client, _admin) = setup();
        let registry = Address::generate(&env);
        client.add_authorized_caller(&registry);
        let agent_id = Symbol::new(&env, "agent7");
        client.record_error(&registry, &agent_id);

        client.pause();

        // Reads should still work when paused.
        assert_eq!(client.get_agent_error_count(&agent_id), 1);
=======
    #[test]
    fn audit_log_records_operations() {
        let (env, client, _admin) = setup();
        let registry = Address::generate(&env);

        client.add_authorized_caller(&registry);
        let log = client.get_audit_log();
        assert!(log.len() >= 1);
>>>>>>> 2df3e3b3a809dfb3562e65cb0d42cb71b77b6d25
    }
}
