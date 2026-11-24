//! On-chain `ErrorResolverContract`: authorization on every privileged path.

use error_resolver::{ContractError, ErrorResolverContract, ErrorResolverContractClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal, Symbol,
};

/// Extracts the typed contract error from a `try_*` result, panicking on
/// success or on a host-level (non-contract) failure.
fn contract_err<T, I>(result: Result<T, Result<ContractError, I>>) -> ContractError {
    match result {
        Err(Ok(err)) => err,
        Err(Err(_)) => panic!("expected contract error, got host error"),
        Ok(_) => panic!("expected contract error, call succeeded"),
    }
}

struct Fixture {
    env: Env,
    client: ErrorResolverContractClient<'static>,
    admin: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(ErrorResolverContract, ());
    let client = ErrorResolverContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    Fixture { env, client, admin }
}

#[test]
fn initialize_requires_admin_auth() {
    let env = Env::default();
    let id = env.register(ErrorResolverContract, ());
    let client = ErrorResolverContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    assert!(client.try_initialize(&admin).is_err());
    assert_eq!(client.get_admin(), None);
}

#[test]
fn admin_entrypoints_reject_without_auth() {
    let f = setup();
    let target = Address::generate(&f.env);
    f.env.mock_auths(&[]);
    assert!(f.client.try_set_quorum(&1).is_err());
    assert!(f.client.try_pause().is_err());
    assert!(f.client.try_unpause().is_err());
    assert!(f.client.try_add_authorized_caller(&target).is_err());
    assert!(f.client.try_remove_authorized_caller(&target).is_err());
    assert!(!f.client.is_authorized_caller(&target));
    assert!(!f.client.is_paused());
}

#[test]
fn admin_entrypoints_reject_auth_from_non_admin() {
    let f = setup();
    let intruder = Address::generate(&f.env);
    let target = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "add_authorized_caller",
            args: (target.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_add_authorized_caller(&target).is_err());
    assert!(!f.client.is_authorized_caller(&target));
}

#[test]
fn admin_auth_is_recorded_for_pause() {
    let f = setup();
    f.client.pause();
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.admin);
    assert!(f.client.is_paused());
    f.client.unpause();
    assert!(!f.client.is_paused());
}

#[test]
fn non_signer_cannot_touch_multisig_flow() {
    let f = setup();
    let stranger = Address::generate(&f.env);
    let target = Address::generate(&f.env);
    let unauthorized = ContractError::Unauthorized;

    assert_eq!(
        contract_err(f.client.try_add_signer(&stranger, &target)),
        unauthorized
    );
    assert_eq!(
        contract_err(f.client.try_remove_signer(&stranger, &f.admin)),
        unauthorized
    );
    assert_eq!(
        contract_err(
            f.client
                .try_propose_allowlist_op(&stranger, &symbol_short!("add"), &target)
        ),
        unauthorized
    );

    let op_id = f
        .client
        .propose_allowlist_op(&f.admin, &symbol_short!("add"), &target);
    assert_eq!(
        contract_err(f.client.try_approve_allowlist_op(&stranger, &op_id)),
        unauthorized
    );
    f.env
        .ledger()
        .set_timestamp(error_resolver::DEFAULT_TIMELOCK + 1);
    assert_eq!(
        contract_err(f.client.try_execute_allowlist_op(&stranger, &op_id)),
        unauthorized
    );
    assert!(!f.client.is_authorized_caller(&target));
}

#[test]
fn signer_without_signature_is_rejected() {
    let f = setup();
    let target = Address::generate(&f.env);
    f.env.mock_auths(&[]);
    assert!(f
        .client
        .try_propose_allowlist_op(&f.admin, &symbol_short!("add"), &target)
        .is_err());
}

#[test]
fn allowlist_gates_record_and_clear() {
    let f = setup();
    let registry = Address::generate(&f.env);
    let agent = Symbol::new(&f.env, "agent");
    let unauthorized = ContractError::Unauthorized;

    assert_eq!(
        contract_err(f.client.try_record_error(&registry, &agent)),
        unauthorized
    );
    assert_eq!(
        contract_err(f.client.try_clear_agent_errors(&registry, &agent)),
        unauthorized
    );

    f.client.add_authorized_caller(&registry);
    assert_eq!(f.client.record_error(&registry, &agent), 1);

    f.client.remove_authorized_caller(&registry);
    assert_eq!(
        contract_err(f.client.try_clear_agent_errors(&registry, &agent)),
        unauthorized
    );
    assert_eq!(f.client.get_agent_error_count(&agent), 1);
}

#[test]
fn allowlisted_caller_must_still_sign() {
    let f = setup();
    let registry = Address::generate(&f.env);
    let agent = Symbol::new(&f.env, "agent");
    f.client.add_authorized_caller(&registry);
    f.env.mock_auths(&[]);
    assert!(f.client.try_record_error(&registry, &agent).is_err());
    assert_eq!(f.client.get_agent_error_count(&agent), 0);
}

#[test]
fn quorum_bounds_are_enforced() {
    let f = setup();
    let quorum_err = ContractError::QuorumNotMet;
    assert_eq!(contract_err(f.client.try_set_quorum(&0)), quorum_err);
    assert_eq!(contract_err(f.client.try_set_quorum(&2)), quorum_err);
    // Removing the last signer is refused.
    assert_eq!(
        contract_err(f.client.try_remove_signer(&f.admin, &f.admin)),
        quorum_err
    );
}

#[test]
fn unknown_op_id_is_rejected() {
    let f = setup();
    let bogus = soroban_sdk::BytesN::from_array(&f.env, &[7; 32]);
    let not_found = ContractError::OpNotFound;
    assert_eq!(
        contract_err(f.client.try_execute_allowlist_op(&f.admin, &bogus)),
        not_found
    );
    assert_eq!(
        contract_err(f.client.try_approve_allowlist_op(&f.admin, &bogus)),
        not_found
    );
}
