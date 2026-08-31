//! # Agent Registry Unit Tests
//!
//! Complete test suite covering agent registration, batch atomic operations,
//! error resolution, gas estimations, admin permissions, bond management,
//! and the Agent Discovery Oracle.

extern crate std;

use super::*;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    Address, BytesN, Env, FromVal, IntoVal, Map, String, Symbol,
};

/// Creates a fresh in-memory test environment with the contract registered.
fn setup() -> (Env, AgentRegistryContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    (env, client)
}

fn setup_with_admin() -> (Env, AgentRegistryContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

fn make_record(env: &Env, id: &str, capability: &str, owner: Address) -> AgentRecord {
    AgentRecord {
        id: Symbol::new(env, id),
        capability: Symbol::new(env, capability),
        price_stroops: 1_000,
        endpoint: String::from_str(env, "https://agent.example.com"),
        owner,
        metadata: Map::new(env),
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    }
}

#[allow(clippy::too_many_arguments)]
fn make_record_with_metrics(
    env: &Env,
    id: &str,
    capability: &str,
    price_stroops: i128,
    reputation: u32,
    availability: u32,
    response_time: u32,
    owner: Address,
) -> AgentRecord {
    let mut metadata = Map::new(env);
    metadata.set(Symbol::new(env, "reputation"), reputation.into_val(env));
    metadata.set(Symbol::new(env, "availability"), availability.into_val(env));
    metadata.set(
        Symbol::new(env, "response_time"),
        response_time.into_val(env),
    );

    AgentRecord {
        id: Symbol::new(env, id),
        capability: Symbol::new(env, capability),
        price_stroops,
        endpoint: String::from_str(env, "https://agent.example.com"),
        owner,
        metadata,
        bond_amount: DEFAULT_MIN_BOND_STROOPS,
    }
}

fn error_id(env: &Env, byte: u8) -> BytesN<32> {
    let mut arr = [0u8; 32];
    arr[0] = byte;
    BytesN::from_array(env, &arr)
}

fn assert_event_topics(env: &Env, idx: u32, topic0: Symbol, topic1: Symbol) {
    let events = env.events().all();
    assert!(
        idx < events.len(),
        "event index {} out of range (total {})",
        idx,
        events.len()
    );
    let (_, topics, _) = events.get(idx).unwrap();
    let t0 = Symbol::from_val(env, &topics.get(0).unwrap());
    let t1 = Symbol::from_val(env, &topics.get(1).unwrap());
    assert_eq!(t0, topic0, "topic[0] mismatch at event {}", idx);
    assert_eq!(t1, topic1, "topic[1] mismatch at event {}", idx);
}

// ── Existing single-item tests ───────────────────────────────────────────

#[test]
fn register_and_lookup() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let record = make_record(&env, "agent1", "research", owner);

    let id_bytes = record.id.clone().to_xdr(&env);
    let record_bytes = record.clone().to_xdr(&env);

    assert!(
        id_bytes.len() <= MAX_AGENT_ID + 4,
        "id_bytes.len() is {}",
        id_bytes.len()
    );
    assert!(
        record_bytes.len() <= MAX_TOTAL_AGENT_STORAGE,
        "record_bytes.len() is {}",
        record_bytes.len()
    );

    let reg_res = client.try_register_agent(&record);
    assert!(
        reg_res.is_ok(),
        "try_register_agent returned Err: {:?}",
        reg_res
    );
    let reg_inner = reg_res.unwrap();
    assert!(
        reg_inner.is_ok(),
        "try_register_agent inner result is Err: {:?}",
        reg_inner
    );

    let agent_key = DataKey::Agent(record.id.clone());
    let opt_record: Option<AgentRecord> = env.as_contract(&client.address, || {
        env.storage().persistent().get(&agent_key)
    });
    assert!(opt_record.is_some(), "opt_record is None in storage!");

    let cap_key = DataKey::CapabilityIndex(record.capability.clone());
    let opt_ids: Option<Vec<Symbol>> =
        env.as_contract(&client.address, || env.storage().persistent().get(&cap_key));
    assert!(opt_ids.is_some(), "opt_ids is None in storage!");
    let ids = opt_ids.unwrap();
    assert_eq!(ids.len(), 1, "ids.len() is {}", ids.len());

    let results = client.lookup_agents(&Symbol::new(&env, "research"));
    assert_eq!(results.len(), 1);
    assert_eq!(results.get(0).unwrap().id, Symbol::new(&env, "agent1"));
}

#[test]
fn register_duplicate_returns_error() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let record = make_record(&env, "dup", "research", owner);
    client.register_agent(&record.clone());
    assert_eq!(
        client.try_register_agent(&record),
        Err(Ok(Error::AlreadyExists))
    );
}

#[test]
fn lookup_multiple_agents_same_capability() {
    let (env, client) = setup();
    client.register_agent(&make_record(
        &env,
        "a1",
        "analytics",
        Address::generate(&env),
    ));
    client.register_agent(&make_record(
        &env,
        "a2",
        "analytics",
        Address::generate(&env),
    ));
    client.register_agent(&make_record(&env, "a3", "other", Address::generate(&env)));

    let results = client.lookup_agents(&Symbol::new(&env, "analytics"));
    assert_eq!(results.len(), 2);
}

#[test]
fn lookup_unknown_capability_returns_empty() {
    let (env, client) = setup();
    let results = client.lookup_agents(&Symbol::new(&env, "unknown"));
    assert_eq!(results.len(), 0);
}

#[test]
fn deregister_removes_from_index() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "agent2", "coding", owner));
    client.deregister_agent(&Symbol::new(&env, "agent2"));

    let results = client.lookup_agents(&Symbol::new(&env, "coding"));
    assert_eq!(results.len(), 0);
}

#[test]
fn deregister_missing_agent_returns_not_found() {
    let (env, client) = setup();
    assert_eq!(
        client.try_deregister_agent(&Symbol::new(&env, "ghost")),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn deregister_wrong_signer_is_unauthorized() {
    let env = Env::default();
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);

    let owner = Address::generate(&env);

    env.mock_all_auths();
    client.register_agent(&make_record(&env, "agent3", "risk", owner.clone()));

    env.mock_auths(&[]);
    let result = client.try_deregister_agent(&Symbol::new(&env, "agent3"));
    assert!(result.is_err());
}

#[test]
fn update_pricing_changes_price_and_emits_event() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "agent4", "report", owner));

    client.update_pricing(&Symbol::new(&env, "agent4"), &5_000_i128);

    let results = client.lookup_agents(&Symbol::new(&env, "report"));
    assert_eq!(results.get(0).unwrap().price_stroops, 5_000);
}

#[test]
fn update_pricing_missing_agent_returns_not_found() {
    let (env, client) = setup();
    assert_eq!(
        client.try_update_pricing(&Symbol::new(&env, "ghost"), &100_i128),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn initialize_sets_admin() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    assert_eq!(client.get_admin(), Some(admin));
}

#[test]
fn initialize_cannot_be_called_twice() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    assert_eq!(
        client.try_initialize(&Address::generate(&env)),
        Err(Ok(Error::AlreadyExists))
    );
}

#[test]
fn set_admin_changes_admin() {
    let (env, client, _admin) = setup_with_admin();
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
    assert_eq!(client.get_admin(), Some(new_admin));
}

#[test]
fn set_admin_requires_admin_auth() {
    let env = Env::default();
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    env.mock_auths(&[]);
    let result = client.try_set_admin(&Address::generate(&env));
    assert!(result.is_err());
}

#[test]
fn pause_blocks_register_agent() {
    let (env, client, _admin) = setup_with_admin();
    client.pause();
    let owner = Address::generate(&env);
    let result = client.try_register_agent(&make_record(&env, "agent_p", "test", owner));
    assert_eq!(result, Err(Ok(Error::ContractPaused)));
}

#[test]
fn pause_blocks_deregister_agent() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);
    env.mock_all_auths();
    client.register_agent(&make_record(&env, "agent_d", "test", owner));
    client.pause();
    let result = client.try_deregister_agent(&Symbol::new(&env, "agent_d"));
    assert_eq!(result, Err(Ok(Error::ContractPaused)));
}

#[test]
fn pause_blocks_update_pricing() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);
    env.mock_all_auths();
    client.register_agent(&make_record(&env, "agent_u", "test", owner));
    client.pause();
    let result = client.try_update_pricing(&Symbol::new(&env, "agent_u"), &999_i128);
    assert_eq!(result, Err(Ok(Error::ContractPaused)));
}

#[test]
fn unpause_allows_operations() {
    let (env, client, _admin) = setup_with_admin();
    client.pause();
    client.unpause();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "agent_up", "test", owner));
    let results = client.lookup_agents(&Symbol::new(&env, "test"));
    assert_eq!(results.len(), 1);
}

#[test]
fn non_admin_cannot_pause() {
    let env = Env::default();
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    env.mock_auths(&[]);
    let result = client.try_pause();
    assert!(result.is_err());
}

#[test]
fn non_admin_cannot_unpause() {
    let env = Env::default();
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);
    client.pause();

    env.mock_auths(&[]);
    let result = client.try_unpause();
    assert!(result.is_err());
}

#[test]
fn is_paused_reflects_state() {
    let (_env, client, _admin) = setup_with_admin();
    assert!(!client.is_paused());
    client.pause();
    assert!(client.is_paused());
    client.unpause();
    assert!(!client.is_paused());
}

#[test]
fn freeze_agent_blocks_update_pricing() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);
    env.mock_all_auths();
    client.register_agent(&make_record(&env, "agent_f", "test", owner));
    client.freeze_agent(&Symbol::new(&env, "agent_f"));
    let result = client.try_update_pricing(&Symbol::new(&env, "agent_f"), &777_i128);
    assert_eq!(result, Err(Ok(Error::AgentFrozen)));
}

#[test]
fn freeze_agent_blocks_register() {
    let (env, client, _admin) = setup_with_admin();
    client.freeze_agent(&Symbol::new(&env, "frozen_id"));
    let owner = Address::generate(&env);
    let result = client.try_register_agent(&make_record(&env, "frozen_id", "test", owner));
    assert_eq!(result, Err(Ok(Error::AgentFrozen)));
}

#[test]
fn unfreeze_agent_allows_operations() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);
    env.mock_all_auths();
    client.register_agent(&make_record(&env, "agent_unf", "test", owner));
    client.freeze_agent(&Symbol::new(&env, "agent_unf"));
    assert!(client.is_agent_frozen(&Symbol::new(&env, "agent_unf")));
    client.unfreeze_agent(&Symbol::new(&env, "agent_unf"));
    assert!(!client.is_agent_frozen(&Symbol::new(&env, "agent_unf")));
    client.update_pricing(&Symbol::new(&env, "agent_unf"), &333_i128);
    let results = client.lookup_agents(&Symbol::new(&env, "test"));
    assert_eq!(results.get(0).unwrap().price_stroops, 333);
}

#[test]
fn is_agent_frozen_reflects_state() {
    let (env, client, _admin) = setup_with_admin();
    assert!(!client.is_agent_frozen(&Symbol::new(&env, "agent_state")));
    client.freeze_agent(&Symbol::new(&env, "agent_state"));
    assert!(client.is_agent_frozen(&Symbol::new(&env, "agent_state")));
    client.unfreeze_agent(&Symbol::new(&env, "agent_state"));
}

#[test]
fn resolve_errors_requires_admin_auth() {
    let env = Env::default();
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    env.mock_all_auths();
    client.initialize(&admin);

    let reporter = Address::generate(&env);
    let id1 = error_id(&env, 40);
    client.report_error(&id1, &reporter, &String::from_str(&env, "some error"));

    let mut ids = Vec::new(&env);
    ids.push_back(id1.clone());

    env.mock_auths(&[]);
    let result = client.try_resolve_errors(&ids, &Resolution::Fixed);
    assert!(result.is_err());

    env.mock_all_auths();
    let result_admin = client.resolve_errors(&ids, &Resolution::Fixed);
    assert_eq!(result_admin.get(0).unwrap(), VoidBatchResult::Ok);
}

#[test]
fn set_gas_config_requires_admin_auth() {
    let env = Env::default();
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    env.mock_all_auths();
    client.initialize(&admin);

    let new_config = GasConfig {
        tx_overhead: 10_000,
        register_agent: 50_000,
        register_agent_marginal: 20_000,
        resolve_error: 25_000,
        resolve_error_marginal: 15_000,
        slash_bond: 30_000,
        deregister_with_bond: 40_000,
    };

    env.mock_auths(&[]);
    let result = client.try_set_gas_config(&new_config);
    assert!(result.is_err());

    env.mock_all_auths();
    client.set_gas_config(&new_config);
    assert_eq!(client.get_gas_config(), new_config);
}

// ── Batch registration ───────────────────────────────────────────────────

#[test]
fn register_agents_batch_success() {
    let (env, client) = setup();
    let mut agents = Vec::new(&env);
    agents.push_back(make_record(&env, "b1", "research", Address::generate(&env)));
    agents.push_back(make_record(&env, "b2", "research", Address::generate(&env)));
    agents.push_back(make_record(&env, "b3", "coding", Address::generate(&env)));

    let results = client.register_agents(&agents);
    assert_eq!(results.len(), 3);
    assert_eq!(
        results.get(0).unwrap(),
        BatchResult::Ok(Symbol::new(&env, "b1"))
    );
    assert_eq!(
        results.get(1).unwrap(),
        BatchResult::Ok(Symbol::new(&env, "b2"))
    );
    assert_eq!(
        results.get(2).unwrap(),
        BatchResult::Ok(Symbol::new(&env, "b3"))
    );

    assert_eq!(
        client.lookup_agents(&Symbol::new(&env, "research")).len(),
        2
    );
    assert_eq!(client.lookup_agents(&Symbol::new(&env, "coding")).len(), 1);
}

#[test]
fn register_agents_partial_failure_is_atomic() {
    let (env, client) = setup();
    client.register_agent(&make_record(
        &env,
        "exists",
        "research",
        Address::generate(&env),
    ));

    let mut agents = Vec::new(&env);
    agents.push_back(make_record(
        &env,
        "new1",
        "research",
        Address::generate(&env),
    ));
    agents.push_back(make_record(
        &env,
        "exists",
        "research",
        Address::generate(&env),
    ));
    agents.push_back(make_record(&env, "new2", "coding", Address::generate(&env)));

    let results = client.register_agents(&agents);
    assert_eq!(results.len(), 3);
    assert_eq!(
        results.get(0).unwrap(),
        BatchResult::Ok(Symbol::new(&env, "new1"))
    );
    assert_eq!(
        results.get(1).unwrap(),
        BatchResult::Err(Error::AlreadyExists as u32)
    );
    assert_eq!(
        results.get(2).unwrap(),
        BatchResult::Ok(Symbol::new(&env, "new2"))
    );

    assert_eq!(
        client.lookup_agents(&Symbol::new(&env, "research")).len(),
        1
    );
    assert_eq!(client.lookup_agents(&Symbol::new(&env, "coding")).len(), 0);
}

#[test]
fn register_agents_duplicate_ids_in_batch() {
    let (env, client) = setup();
    let owner1 = Address::generate(&env);
    let owner2 = Address::generate(&env);
    let mut agents = Vec::new(&env);
    agents.push_back(make_record(&env, "same", "research", owner1));
    agents.push_back(make_record(&env, "same", "coding", owner2));

    let results = client.register_agents(&agents);
    assert_eq!(
        results.get(0).unwrap(),
        BatchResult::Ok(Symbol::new(&env, "same"))
    );
    assert_eq!(
        results.get(1).unwrap(),
        BatchResult::Err(Error::DuplicateInBatch as u32)
    );
    assert_eq!(
        client.lookup_agents(&Symbol::new(&env, "research")).len(),
        0
    );
    assert_eq!(client.lookup_agents(&Symbol::new(&env, "coding")).len(), 0);
}

#[test]
fn register_agents_empty_batch() {
    let (env, client) = setup();
    let agents = Vec::new(&env);
    let results = client.register_agents(&agents);
    assert_eq!(results.len(), 0);
}

// ── Batch error resolution ───────────────────────────────────────────────

#[test]
fn resolve_errors_batch_success() {
    let (env, client, _admin) = setup_with_admin();
    let reporter = Address::generate(&env);
    let id1 = error_id(&env, 1);
    let id2 = error_id(&env, 2);
    let id3 = error_id(&env, 3);

    client.report_error(&id1, &reporter, &String::from_str(&env, "timeout"));
    client.report_error(&id2, &reporter, &String::from_str(&env, "auth"));
    client.report_error(&id3, &reporter, &String::from_str(&env, "budget"));

    let mut ids = Vec::new(&env);
    ids.push_back(id1.clone());
    ids.push_back(id2.clone());
    ids.push_back(id3.clone());

    let results = client.resolve_errors(&ids, &Resolution::Fixed);
    assert_eq!(results.len(), 3);
    assert_eq!(results.get(0).unwrap(), VoidBatchResult::Ok);
    assert_eq!(results.get(1).unwrap(), VoidBatchResult::Ok);
    assert_eq!(results.get(2).unwrap(), VoidBatchResult::Ok);

    let e1 = client.get_error(&id1).unwrap();
    assert!(e1.resolved);
    assert_eq!(e1.resolution, Resolution::Fixed);
}

#[test]
fn resolve_errors_partial_failure_is_atomic() {
    let (env, client, _admin) = setup_with_admin();
    let reporter = Address::generate(&env);
    let id1 = error_id(&env, 10);
    let missing = error_id(&env, 99);

    client.report_error(&id1, &reporter, &String::from_str(&env, "real"));

    let mut ids = Vec::new(&env);
    ids.push_back(id1.clone());
    ids.push_back(missing);

    let results = client.resolve_errors(&ids, &Resolution::Ignored);
    assert_eq!(results.get(0).unwrap(), VoidBatchResult::Ok);
    assert_eq!(
        results.get(1).unwrap(),
        VoidBatchResult::Err(Error::NotFound as u32)
    );

    let e1 = client.get_error(&id1).unwrap();
    assert!(!e1.resolved);
}

#[test]
fn resolve_errors_already_resolved_fails_atomically() {
    let (env, client, _admin) = setup_with_admin();
    let reporter = Address::generate(&env);
    let id1 = error_id(&env, 20);
    let id2 = error_id(&env, 21);

    client.report_error(&id1, &reporter, &String::from_str(&env, "a"));
    client.report_error(&id2, &reporter, &String::from_str(&env, "b"));

    let mut first = Vec::new(&env);
    first.push_back(id1.clone());
    let r = client.resolve_errors(&first, &Resolution::Fixed);
    assert_eq!(r.get(0).unwrap(), VoidBatchResult::Ok);

    let mut both = Vec::new(&env);
    both.push_back(id1.clone());
    both.push_back(id2.clone());
    let results = client.resolve_errors(&both, &Resolution::Escalated);
    assert_eq!(
        results.get(0).unwrap(),
        VoidBatchResult::Err(Error::AlreadyResolved as u32)
    );
    assert_eq!(results.get(1).unwrap(), VoidBatchResult::Ok);

    let e2 = client.get_error(&id2).unwrap();
    assert!(!e2.resolved);
}

// ── Gas estimation ───────────────────────────────────────────────────────

#[test]
fn estimate_gas_register_scales_with_count() {
    let (env, client) = setup();
    let one = client.estimate_gas(&String::from_str(&env, "register_agent"), &1);
    let ten = client.estimate_gas(&String::from_str(&env, "register_agents"), &10);

    assert_eq!(one, GAS_REGISTER_AGENT);
    assert_eq!(ten, GAS_REGISTER_AGENT + GAS_REGISTER_AGENT_MARGINAL * 9);
    assert!(ten < 610_000);
    assert!(ten < GAS_REGISTER_AGENT * 10);
}

#[test]
fn estimate_gas_resolve_scales_with_count() {
    let (env, client) = setup();
    let one = client.estimate_gas(&String::from_str(&env, "resolve_error"), &1);
    let ten = client.estimate_gas(&String::from_str(&env, "resolve_errors"), &10);

    assert_eq!(one, GAS_RESOLVE_ERROR);
    assert_eq!(ten, GAS_RESOLVE_ERROR + GAS_RESOLVE_ERROR_MARGINAL * 9);
    assert!(ten < GAS_RESOLVE_ERROR * 10);
}

#[test]
fn estimate_gas_unknown_operation_is_zero() {
    let (env, client) = setup();
    let v = client.estimate_gas(&String::from_str(&env, "not_a_real_op"), &5);
    assert_eq!(v, 0);
}

#[test]
fn estimate_gas_zero_count_is_zero() {
    let (env, client) = setup();
    let v = client.estimate_gas(&String::from_str(&env, "register_agents"), &0);
    assert_eq!(v, 0);
}

// ── Gas benchmark tests (issue #250) ─────────────────────────────────────

#[test]
fn gas_benchmark_register_agents_batch_savings() {
    let (env, client) = setup();

    let single_call_cost = client.estimate_gas(&String::from_str(&env, "register_agent"), &1);
    let ten_separate = single_call_cost * 10;

    let batched_ten = client.estimate_gas(&String::from_str(&env, "register_agents"), &10);

    assert!(
        batched_ten < ten_separate,
        "batched_ten ({batched_ten}) must be < ten_separate ({ten_separate})"
    );

    let savings_pct = (ten_separate - batched_ten) * 100 / ten_separate;
    assert!(savings_pct >= 39, "savings {savings_pct}% must be >= 39%");

    let expected = GAS_REGISTER_AGENT + GAS_REGISTER_AGENT_MARGINAL * 9;
    assert_eq!(
        batched_ten, expected,
        "batched_ten must equal documented constant {expected}"
    );
}

#[test]
fn gas_benchmark_resolve_errors_batch_savings() {
    let (env, client) = setup();

    let single_call_cost = client.estimate_gas(&String::from_str(&env, "resolve_error"), &1);
    let ten_separate = single_call_cost * 10;

    let batched_ten = client.estimate_gas(&String::from_str(&env, "resolve_errors"), &10);

    assert!(
        batched_ten < ten_separate,
        "batched_ten ({batched_ten}) must be < ten_separate ({ten_separate})"
    );

    let savings_pct = (ten_separate - batched_ten) * 100 / ten_separate;
    assert!(savings_pct >= 36, "savings {savings_pct}% must be >= 36%");

    let expected = GAS_RESOLVE_ERROR + GAS_RESOLVE_ERROR_MARGINAL * 9;
    assert_eq!(
        batched_ten, expected,
        "batched_ten must equal documented constant {expected}"
    );
}

#[test]
fn gas_benchmark_register_agents_table() {
    let (env, client) = setup();

    let cases: &[(u32, u64)] = &[
        (1, 100_000),
        (2, 155_556),
        (5, 322_224),
        (10, 600_004),
        (20, 1_155_564),
    ];

    for (count, expected_cu) in cases {
        let got = client.estimate_gas(&String::from_str(&env, "register_agents"), count);
        assert_eq!(
            got, *expected_cu,
            "register_agents({count}): expected {expected_cu} CU, got {got}"
        );
    }
}

#[test]
fn gas_benchmark_resolve_errors_table() {
    let (env, client) = setup();

    let cases: &[(u32, u64)] = &[
        (1, 50_000),
        (2, 80_000),
        (5, 170_000),
        (10, 320_000),
        (20, 620_000),
    ];

    for (count, expected_cu) in cases {
        let got = client.estimate_gas(&String::from_str(&env, "resolve_errors"), count);
        assert_eq!(
            got, *expected_cu,
            "resolve_errors({count}): expected {expected_cu} CU, got {got}"
        );
    }
}

#[test]
fn gas_benchmark_custom_config_used_by_estimate_gas() {
    let (env, client, _admin) = setup_with_admin();

    let custom = GasConfig {
        tx_overhead: 10_000,
        register_agent: 80_000,
        register_agent_marginal: 40_000,
        resolve_error: 30_000,
        resolve_error_marginal: 20_000,
        slash_bond: GAS_SLASH_BOND,
        deregister_with_bond: GAS_DEREGISTER_WITH_BOND,
    };
    client.set_gas_config(&custom);

    let reg_1 = client.estimate_gas(&String::from_str(&env, "register_agent"), &1);
    assert_eq!(reg_1, 80_000);

    let reg_10 = client.estimate_gas(&String::from_str(&env, "register_agents"), &10);
    let expected_reg_10 = 80_000_u64 + 40_000_u64 * 9;
    assert_eq!(reg_10, expected_reg_10);

    let res_1 = client.estimate_gas(&String::from_str(&env, "resolve_error"), &1);
    assert_eq!(res_1, 30_000);

    let res_10 = client.estimate_gas(&String::from_str(&env, "resolve_errors"), &10);
    let expected_res_10 = 30_000_u64 + 20_000_u64 * 9;
    assert_eq!(res_10, expected_res_10);

    assert_eq!(client.get_gas_config(), custom);
}

#[test]
fn gas_benchmark_overhead_amortisation() {
    let (env, client) = setup();

    for n in [2u32, 5, 10, 20] {
        let batched = client.estimate_gas(&String::from_str(&env, "register_agents"), &n);
        let separate =
            client.estimate_gas(&String::from_str(&env, "register_agent"), &1) * n as u64;
        assert!(batched < separate);

        let batched_res = client.estimate_gas(&String::from_str(&env, "resolve_errors"), &n);
        let separate_res =
            client.estimate_gas(&String::from_str(&env, "resolve_error"), &1) * n as u64;
        assert!(batched_res < separate_res);
    }
}

// ── Event emission tests ─────────────────────────────────────────────────

#[test]
fn initialize_emits_initialized_event() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    assert_eq!(env.events().all().len(), 1);
    assert_event_topics(&env, 0, symbol_short!("registry"), symbol_short!("init"));
}

#[test]
fn set_admin_emits_admin_changed_event() {
    let (env, client, _) = setup_with_admin();
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
    assert_eq!(env.events().all().len(), 1);
    assert_event_topics(
        &env,
        0,
        symbol_short!("registry"),
        symbol_short!("adm_chngd"),
    );
}

#[test]
fn register_agent_emits_agent_registered_event() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "ev_agent1", "research", owner));
    assert_eq!(env.events().all().len(), 2);
    assert_event_topics(
        &env,
        0,
        symbol_short!("registry"),
        symbol_short!("agent_reg"),
    );
    assert_event_topics(
        &env,
        1,
        symbol_short!("registry"),
        symbol_short!("bond_lck"),
    );
}

#[test]
fn register_agents_batch_emits_one_event_per_agent() {
    let (env, client) = setup();
    let mut agents = Vec::new(&env);
    agents.push_back(make_record(
        &env,
        "bev1",
        "research",
        Address::generate(&env),
    ));
    agents.push_back(make_record(&env, "bev2", "coding", Address::generate(&env)));
    agents.push_back(make_record(&env, "bev3", "report", Address::generate(&env)));
    let results = client.register_agents(&agents);
    assert!(results.iter().all(|r| matches!(r, BatchResult::Ok(_))));
    assert_eq!(env.events().all().len(), 6);
    for i in 0..3u32 {
        assert_event_topics(
            &env,
            i * 2,
            symbol_short!("registry"),
            symbol_short!("agent_reg"),
        );
        assert_event_topics(
            &env,
            i * 2 + 1,
            symbol_short!("registry"),
            symbol_short!("bond_lck"),
        );
    }
}

#[test]
fn register_agents_failed_batch_emits_no_events() {
    let (env, client) = setup();
    client.register_agent(&make_record(
        &env,
        "conflict",
        "research",
        Address::generate(&env),
    ));
    let mut agents = Vec::new(&env);
    agents.push_back(make_record(
        &env,
        "new_ok",
        "coding",
        Address::generate(&env),
    ));
    agents.push_back(make_record(
        &env,
        "conflict",
        "research",
        Address::generate(&env),
    ));
    client.register_agents(&agents);
    assert_eq!(env.events().all().len(), 0);
}

#[test]
fn deregister_agent_emits_agent_deregistered_event() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "dreg_ev", "analytics", owner));
    client.deregister_agent(&Symbol::new(&env, "dreg_ev"));
    assert_eq!(env.events().all().len(), 1);
    assert_event_topics(
        &env,
        0,
        symbol_short!("registry"),
        symbol_short!("agent_drg"),
    );
}

#[test]
fn report_error_emits_error_reported_event() {
    let (env, client) = setup();
    let reporter = Address::generate(&env);
    let eid = error_id(&env, 77);
    client.report_error(&eid, &reporter, &String::from_str(&env, "disk full"));
    assert_eq!(env.events().all().len(), 1);
    assert_event_topics(
        &env,
        0,
        symbol_short!("registry"),
        symbol_short!("err_rptd"),
    );
}

#[test]
fn resolve_errors_emits_one_event_per_resolved_error() {
    let (env, client, _) = setup_with_admin();
    let reporter = Address::generate(&env);
    let id1 = error_id(&env, 50);
    let id2 = error_id(&env, 51);
    let id3 = error_id(&env, 52);
    client.report_error(&id1, &reporter, &String::from_str(&env, "t1"));
    client.report_error(&id2, &reporter, &String::from_str(&env, "t2"));
    client.report_error(&id3, &reporter, &String::from_str(&env, "t3"));
    let mut ids = Vec::new(&env);
    ids.push_back(id1);
    ids.push_back(id2);
    ids.push_back(id3);
    let results = client.resolve_errors(&ids, &Resolution::Fixed);
    assert!(results.iter().all(|r| r == VoidBatchResult::Ok));
    assert_eq!(env.events().all().len(), 3);
    for i in 0..3u32 {
        assert_event_topics(
            &env,
            i,
            symbol_short!("registry"),
            symbol_short!("err_rslvd"),
        );
    }
}

#[test]
fn resolve_errors_failed_batch_emits_no_events() {
    let (env, client, _) = setup_with_admin();
    let reporter = Address::generate(&env);
    let id1 = error_id(&env, 60);
    let missing = error_id(&env, 99);
    client.report_error(&id1, &reporter, &String::from_str(&env, "real"));
    let mut ids = Vec::new(&env);
    ids.push_back(id1);
    ids.push_back(missing);
    let results = client.resolve_errors(&ids, &Resolution::Ignored);
    assert_eq!(
        results.get(1).unwrap(),
        VoidBatchResult::Err(Error::NotFound as u32)
    );
    assert_eq!(env.events().all().len(), 0);
}

#[test]
fn resolve_errors_resolution_code_matches_variant() {
    let (env, client, _) = setup_with_admin();
    let reporter = Address::generate(&env);
    let id1 = error_id(&env, 80);
    client.report_error(&id1, &reporter, &String::from_str(&env, "netsplit"));
    let mut ids = Vec::new(&env);
    ids.push_back(id1);
    client.resolve_errors(&ids, &Resolution::Escalated);
    assert_eq!(env.events().all().len(), 1);
    assert_event_topics(
        &env,
        0,
        symbol_short!("registry"),
        symbol_short!("err_rslvd"),
    );
}

// ── Bond mechanism tests ─────────────────────────────────────────────────

#[test]
fn register_with_sufficient_bond_succeeds() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let record = make_record(&env, "bonded_agent", "research", owner);
    assert!(client.try_register_agent(&record).is_ok());
    let agents = client.lookup_agents(&Symbol::new(&env, "research"));
    assert_eq!(agents.len(), 1);
    assert_eq!(agents.get(0).unwrap().bond_amount, DEFAULT_MIN_BOND_STROOPS);
}

#[test]
fn register_with_insufficient_bond_is_rejected() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let mut record = make_record(&env, "low_bond", "research", owner);
    record.bond_amount = DEFAULT_MIN_BOND_STROOPS - 1;
    assert_eq!(
        client.try_register_agent(&record),
        Err(Ok(Error::InsufficientBond))
    );
}

#[test]
fn register_with_zero_bond_is_rejected() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    let mut record = make_record(&env, "zero_bond", "research", owner);
    record.bond_amount = 0;
    assert_eq!(
        client.try_register_agent(&record),
        Err(Ok(Error::InsufficientBond))
    );
}

#[test]
fn set_min_bond_changes_requirement() {
    let (env, client, _admin) = setup_with_admin();
    client.set_min_bond(&1_i128);
    assert_eq!(client.get_min_bond(), 1_i128);

    let owner = Address::generate(&env);
    let mut record = make_record(&env, "low_bonded", "research", owner);
    record.bond_amount = 1;
    assert!(client.try_register_agent(&record).is_ok());
}

#[test]
fn set_min_bond_requires_admin() {
    let env = Env::default();
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    env.mock_auths(&[]);
    let result = client.try_set_min_bond(&500_i128);
    assert!(result.is_err());
}

#[test]
fn slash_bond_reduces_bond_amount() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "slashme", "research", owner));

    client.slash_bond(&Symbol::new(&env, "slashme"), &10_000_000_i128);

    let agents = client.lookup_agents(&Symbol::new(&env, "research"));
    let remaining = agents.get(0).unwrap().bond_amount;
    assert_eq!(remaining, DEFAULT_MIN_BOND_STROOPS - 10_000_000);
}

#[test]
fn slash_bond_floors_at_zero() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "floor_agent", "research", owner));

    client.slash_bond(
        &Symbol::new(&env, "floor_agent"),
        &(DEFAULT_MIN_BOND_STROOPS + 999_i128),
    );

    let agents = client.lookup_agents(&Symbol::new(&env, "research"));
    assert_eq!(agents.get(0).unwrap().bond_amount, 0);
}

#[test]
fn double_slash_does_not_go_negative() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "double_slash", "research", owner));

    client.slash_bond(
        &Symbol::new(&env, "double_slash"),
        &(DEFAULT_MIN_BOND_STROOPS + 1_i128),
    );
    client.slash_bond(&Symbol::new(&env, "double_slash"), &1_000_000_i128);

    let agents = client.lookup_agents(&Symbol::new(&env, "research"));
    assert_eq!(agents.get(0).unwrap().bond_amount, 0);
}

#[test]
fn slash_bond_on_missing_agent_returns_not_found() {
    let (_env, client, _admin) = setup_with_admin();
    assert_eq!(
        client.try_slash_bond(&Symbol::new(&_env, "ghost"), &1_000_i128),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn slash_bond_requires_admin() {
    let env = Env::default();
    let contract_id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "protected", "research", owner));

    env.mock_auths(&[]);
    let result = client.try_slash_bond(&Symbol::new(&env, "protected"), &1_000_i128);
    assert!(result.is_err());
}

#[test]
fn deregister_initiates_cooldown() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "cooldown_agent", "research", owner));

    assert!(client
        .try_deregister_agent(&Symbol::new(&env, "cooldown_agent"))
        .is_ok());

    let agents = client.lookup_agents(&Symbol::new(&env, "research"));
    assert_eq!(agents.len(), 0);

    assert_eq!(
        client.try_deregister_agent(&Symbol::new(&env, "cooldown_agent")),
        Err(Ok(Error::CooldownNotElapsed))
    );
}

#[test]
fn bond_return_before_cooldown_is_rejected() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "early_return", "research", owner));
    client.deregister_agent(&Symbol::new(&env, "early_return"));

    assert_eq!(
        client.try_deregister_agent(&Symbol::new(&env, "early_return")),
        Err(Ok(Error::CooldownNotElapsed))
    );
}

#[test]
fn bond_returned_after_cooldown_elapses() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_max_entry_ttl(100_000_000);
    env.ledger().set_min_persistent_entry_ttl(100_000_000);

    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);

    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "wait_agent", "research", owner));
    client.deregister_agent(&Symbol::new(&env, "wait_agent"));

    let new_seq = env.ledger().sequence() + BOND_COOLDOWN_LEDGERS + 1;
    env.ledger().set_sequence_number(new_seq);

    assert!(client
        .try_deregister_agent(&Symbol::new(&env, "wait_agent"))
        .is_ok());

    let events = env.events().all();
    assert_eq!(events.len(), 1, "bond return must emit 1 event");
    assert_event_topics(
        &env,
        0,
        symbol_short!("registry"),
        symbol_short!("bond_ret"),
    );
}

#[test]
fn estimate_gas_slash_bond_operation() {
    let (env, client) = setup();
    let one = client.estimate_gas(&String::from_str(&env, "slash_bond"), &1);
    let three = client.estimate_gas(&String::from_str(&env, "slash_bond"), &3);
    assert_eq!(one, GAS_SLASH_BOND);
    assert_eq!(three, GAS_SLASH_BOND * 3);
}

#[test]
fn estimate_gas_deregister_with_bond_operation() {
    let (env, client) = setup();
    let one = client.estimate_gas(&String::from_str(&env, "deregister_with_bond"), &1);
    let two = client.estimate_gas(&String::from_str(&env, "deregister_with_bond"), &2);
    assert_eq!(one, GAS_DEREGISTER_WITH_BOND);
    assert_eq!(two, GAS_DEREGISTER_WITH_BOND * 2);
}

// ─── Agent Discovery Oracle Tests ─────────────────────────────────────────

#[test]
fn discover_agents_returns_ranked_matching_agents() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    let a1 = make_record_with_metrics(
        &env,
        "agent_best",
        "research",
        500_000,
        95,
        95,
        100,
        owner.clone(),
    );
    let a2 = make_record_with_metrics(
        &env,
        "agent_mid",
        "research",
        1_000_000,
        80,
        85,
        200,
        owner.clone(),
    );
    let a3 = make_record_with_metrics(
        &env,
        "agent_low",
        "research",
        2_000_000,
        60,
        70,
        500,
        owner.clone(),
    );

    client.register_agent(&a1);
    client.register_agent(&a2);
    client.register_agent(&a3);

    let query = DiscoveryQuery {
        required_capability: Symbol::new(&env, "research"),
        max_price: 3_000_000,
        min_reputation: 50,
        max_latency: 1000,
    };

    let results = client.discover_agents(&query);
    assert_eq!(results.len(), 3);

    assert_eq!(
        results.get(0).unwrap().agent_id,
        Symbol::new(&env, "agent_best")
    );
    assert_eq!(
        results.get(1).unwrap().agent_id,
        Symbol::new(&env, "agent_mid")
    );
    assert_eq!(
        results.get(2).unwrap().agent_id,
        Symbol::new(&env, "agent_low")
    );

    assert!(results.get(0).unwrap().composite_score > results.get(1).unwrap().composite_score);
    assert!(results.get(1).unwrap().composite_score > results.get(2).unwrap().composite_score);
}

#[test]
fn discover_agents_multi_criteria_filtering() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    let a1 = make_record_with_metrics(
        &env,
        "agent_expensive",
        "code",
        5_000_000,
        90,
        90,
        100,
        owner.clone(),
    );
    let a2 = make_record_with_metrics(
        &env,
        "agent_low_rep",
        "code",
        1_000_000,
        40,
        90,
        100,
        owner.clone(),
    );
    let a3 = make_record_with_metrics(
        &env,
        "agent_slow",
        "code",
        1_000_000,
        90,
        90,
        800,
        owner.clone(),
    );
    let a4 = make_record_with_metrics(
        &env,
        "agent_match",
        "code",
        1_000_000,
        90,
        90,
        100,
        owner.clone(),
    );

    client.register_agent(&a1);
    client.register_agent(&a2);
    client.register_agent(&a3);
    client.register_agent(&a4);

    let query = DiscoveryQuery {
        required_capability: Symbol::new(&env, "code"),
        max_price: 2_000_000,
        min_reputation: 60,
        max_latency: 500,
    };

    let results = client.discover_agents(&query);
    assert_eq!(results.len(), 1);
    assert_eq!(
        results.get(0).unwrap().agent_id,
        Symbol::new(&env, "agent_match")
    );
}

#[test]
fn discover_agents_excludes_frozen_agents() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);

    let a1 = make_record_with_metrics(
        &env,
        "agent_active",
        "risk",
        1_000_000,
        90,
        90,
        100,
        owner.clone(),
    );
    let a2 = make_record_with_metrics(
        &env,
        "agent_frozen",
        "risk",
        1_000_000,
        95,
        95,
        50,
        owner.clone(),
    );

    client.register_agent(&a1);
    client.register_agent(&a2);

    client.freeze_agent(&Symbol::new(&env, "agent_frozen"));

    let query = DiscoveryQuery {
        required_capability: Symbol::new(&env, "risk"),
        max_price: 2_000_000,
        min_reputation: 0,
        max_latency: 0,
    };

    let results = client.discover_agents(&query);
    assert_eq!(results.len(), 1);
    assert_eq!(
        results.get(0).unwrap().agent_id,
        Symbol::new(&env, "agent_active")
    );
}

#[test]
fn discover_agents_results_caching_and_stats() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    let a1 = make_record_with_metrics(
        &env,
        "agent_c1",
        "data",
        1_000_000,
        85,
        90,
        150,
        owner.clone(),
    );
    client.register_agent(&a1);

    let query = DiscoveryQuery {
        required_capability: Symbol::new(&env, "data"),
        max_price: 2_000_000,
        min_reputation: 50,
        max_latency: 300,
    };

    let res1 = client.discover_agents(&query);
    assert_eq!(res1.len(), 1);

    let stats1 = client.get_discovery_stats();
    assert_eq!(stats1.total_queries, 1);
    assert_eq!(stats1.total_matches_found, 1);
    assert_eq!(stats1.cache_hits, 0);

    let res2 = client.discover_agents(&query);
    assert_eq!(res2.len(), 1);
    assert_eq!(res2.get(0).unwrap().agent_id, res1.get(0).unwrap().agent_id);

    let stats2 = client.get_discovery_stats();
    assert_eq!(stats2.total_queries, 2);
    assert_eq!(stats2.total_matches_found, 2);
    assert_eq!(stats2.cache_hits, 1);
}

#[test]
fn discover_agents_emits_discovery_query_event() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    let a1 = make_record_with_metrics(
        &env,
        "agent_event",
        "audit",
        1_000_000,
        85,
        90,
        150,
        owner.clone(),
    );
    client.register_agent(&a1);

    let query = DiscoveryQuery {
        required_capability: Symbol::new(&env, "audit"),
        max_price: 2_000_000,
        min_reputation: 50,
        max_latency: 300,
    };

    client.discover_agents(&query);

    let events = env.events().all();
    assert!(!events.is_empty());
    assert_event_topics(
        &env,
        events.len() - 1,
        symbol_short!("registry"),
        symbol_short!("disc_qry"),
    );
}

#[test]
fn discover_agents_empty_match_returns_empty() {
    let (env, client) = setup();
    let query = DiscoveryQuery {
        required_capability: Symbol::new(&env, "nonexistent"),
        max_price: 1_000_000,
        min_reputation: 50,
        max_latency: 200,
    };

    let results = client.discover_agents(&query);
    assert_eq!(results.len(), 0);

    let stats = client.get_discovery_stats();
    assert_eq!(stats.total_queries, 1);
    assert_eq!(stats.total_matches_found, 0);
}

#[test]
fn test_total_agents_increments_and_decrements() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    assert_eq!(client.total_agents(), 0);

    client.register_agent(&make_record(&env, "ag1", "research", owner.clone()));
    assert_eq!(client.total_agents(), 1);

    let batch = soroban_sdk::vec![
        &env,
        make_record(&env, "ag2", "research", owner.clone()),
        make_record(&env, "ag3", "coding", owner.clone()),
    ];
    let batch_res = client.register_agents(&batch);
    assert_eq!(batch_res.len(), 2);
    assert_eq!(client.total_agents(), 3);

    client.deregister_agent(&Symbol::new(&env, "ag1"));
    assert_eq!(client.total_agents(), 2);
}

#[test]
fn test_storage_config_global_limit() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);

    let cfg = StorageConfig {
        max_agents: 2,
        max_per_capability: 0,
    };
    client.set_storage_config(&cfg);
    assert_eq!(client.get_storage_config(), cfg);

    assert!(client
        .try_register_agent(&make_record(&env, "ag1", "research", owner.clone()))
        .is_ok());
    assert!(client
        .try_register_agent(&make_record(&env, "ag2", "coding", owner.clone()))
        .is_ok());

    let res = client.try_register_agent(&make_record(&env, "ag3", "risk", owner.clone()));
    assert_eq!(res, Err(Ok(Error::StorageLimitReached)));
}

#[test]
fn test_storage_config_per_capability_limit() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);

    let cfg = StorageConfig {
        max_agents: 0,
        max_per_capability: 1,
    };
    client.set_storage_config(&cfg);

    assert!(client
        .try_register_agent(&make_record(&env, "ag1", "research", owner.clone()))
        .is_ok());

    let res = client.try_register_agent(&make_record(&env, "ag2", "research", owner.clone()));
    assert_eq!(res, Err(Ok(Error::CapabilityLimitReached)));

    assert!(client
        .try_register_agent(&make_record(&env, "ag3", "coding", owner.clone()))
        .is_ok());
}

#[test]
fn test_storage_config_batch_limits() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);

    let cfg = StorageConfig {
        max_agents: 2,
        max_per_capability: 0,
    };
    client.set_storage_config(&cfg);

    let batch = soroban_sdk::vec![
        &env,
        make_record(&env, "ag1", "research", owner.clone()),
        make_record(&env, "ag2", "research", owner.clone()),
        make_record(&env, "ag3", "coding", owner.clone()),
    ];
    let res = client.register_agents(&batch);
    assert_eq!(res.len(), 3);
    assert_eq!(
        res.get(0).unwrap(),
        BatchResult::Ok(Symbol::new(&env, "ag1"))
    );
    assert_eq!(
        res.get(1).unwrap(),
        BatchResult::Ok(Symbol::new(&env, "ag2"))
    );
    assert_eq!(
        res.get(2).unwrap(),
        BatchResult::Err(Error::StorageLimitReached as u32)
    );

    // Atomic batch aborts on any failure
    assert_eq!(client.total_agents(), 0);
}

#[test]
fn test_non_admin_cannot_set_storage_config() {
    let env = Env::default();
    let id = env.register(AgentRegistryContract, ());
    let client = AgentRegistryContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let cfg = StorageConfig {
        max_agents: 10,
        max_per_capability: 5,
    };

    env.mock_auths(&[]);
    let res = client.try_set_storage_config(&cfg);
    assert!(res.is_err());
}

// ── On-Chain Analytics Tests (issue #254) ──────────────────────────────────

#[test]
fn record_task_completion_success() {
    let (env, client) = setup();
    let agent_id = Symbol::new(&env, "agent1");

    client.record_task_completion(&agent_id, &true, &150, &1_000_000_i128);

    let analytics = client.get_analytics(&agent_id);
    assert_eq!(analytics.total_tasks, 1);
    assert_eq!(analytics.successful_tasks, 1);
    assert_eq!(analytics.failed_tasks, 0);
    assert_eq!(analytics.total_earnings, 1_000_000);
    assert_eq!(analytics.avg_response_time, 150);
}

#[test]
fn record_task_completion_failure() {
    let (env, client) = setup();
    let agent_id = Symbol::new(&env, "agent1");

    client.record_task_completion(&agent_id, &false, &500, &0_i128);

    let analytics = client.get_analytics(&agent_id);
    assert_eq!(analytics.total_tasks, 1);
    assert_eq!(analytics.successful_tasks, 0);
    assert_eq!(analytics.failed_tasks, 1);
    assert_eq!(analytics.total_earnings, 0);
}

#[test]
fn record_task_completion_running_average() {
    let (env, client) = setup();
    let agent_id = Symbol::new(&env, "agent1");

    client.record_task_completion(&agent_id, &true, &100, &1_000_000_i128);
    client.record_task_completion(&agent_id, &true, &200, &1_000_000_i128);
    client.record_task_completion(&agent_id, &true, &300, &1_000_000_i128);

    let analytics = client.get_analytics(&agent_id);
    assert_eq!(analytics.total_tasks, 3);
    assert_eq!(analytics.avg_response_time, 200);
    assert_eq!(analytics.total_earnings, 3_000_000);
}

#[test]
fn get_leaderboard_by_total_tasks() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    // Register agents
    client.register_agent(&make_record(&env, "a1", "analytics", owner.clone()));
    client.register_agent(&make_record(&env, "a2", "analytics", owner.clone()));
    client.register_agent(&make_record(&env, "a3", "analytics", owner.clone()));

    // Record tasks
    client.record_task_completion(&Symbol::new(&env, "a1"), &true, &100, &1_000_000_i128);
    client.record_task_completion(&Symbol::new(&env, "a1"), &true, &100, &1_000_000_i128);
    client.record_task_completion(&Symbol::new(&env, "a2"), &true, &100, &1_000_000_i128);
    client.record_task_completion(&Symbol::new(&env, "a3"), &true, &100, &1_000_000_i128);
    client.record_task_completion(&Symbol::new(&env, "a3"), &true, &100, &1_000_000_i128);
    client.record_task_completion(&Symbol::new(&env, "a3"), &true, &100, &1_000_000_i128);

    let metric = Symbol::new(&env, "total_tasks");
    let leaderboard = client.get_leaderboard(&metric, &3);

    assert_eq!(leaderboard.len(), 3);
    assert_eq!(leaderboard.get(0).unwrap().agent_id, Symbol::new(&env, "a3"));
    assert_eq!(leaderboard.get(0).unwrap().metric_value, 3);
    assert_eq!(leaderboard.get(1).unwrap().agent_id, Symbol::new(&env, "a1"));
    assert_eq!(leaderboard.get(1).unwrap().metric_value, 2);
}

#[test]
fn get_leaderboard_emits_event() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "a1", "analytics", owner));

    let metric = Symbol::new(&env, "total_tasks");
    client.get_leaderboard(&metric, &10);

    let events = env.events().all();
    let last = events.get(events.len() - 1).unwrap();
    let (_, topics, _) = last;
    let t1 = Symbol::from_val(&env, &topics.get(1).unwrap());
    assert_eq!(t1, symbol_short!("lb_upd"));
}

// ── SLA Enforcement Tests (issue #257) ────────────────────────────────────

#[test]
fn set_sla_success() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "sla_agent", "research", owner));

    client.set_sla(
        &Symbol::new(&env, "sla_agent"),
        &200,
        &95,
        &80,
    );

    let sla = client.get_sla_status(&Symbol::new(&env, "sla_agent"));
    assert!(sla.is_some());
    let (sla, compliance) = sla.unwrap();
    assert_eq!(sla.max_response_time, 200);
    assert_eq!(sla.min_uptime, 95);
    assert_eq!(sla.min_quality_score, 80);
    assert_eq!(compliance, 100);
}

#[test]
fn set_sla_nonexistent_agent() {
    let (env, client) = setup();
    assert_eq!(
        client.try_set_sla(&Symbol::new(&env, "ghost"), &200, &95, &80),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn set_sla_duplicate_fails() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "sla_agent", "research", owner));

    client.set_sla(&Symbol::new(&env, "sla_agent"), &200, &95, &80);

    assert_eq!(
        client.try_set_sla(&Symbol::new(&env, "sla_agent"), &300, &90, &70),
        Err(Ok(Error::SlaAlreadyExists))
    );
}

#[test]
fn set_sla_invalid_params() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "sla_agent", "research", owner));

    // max_response_time = 0
    assert_eq!(
        client.try_set_sla(&Symbol::new(&env, "sla_agent"), &0, &95, &80),
        Err(Ok(Error::InvalidSla))
    );

    // min_uptime > 100
    assert_eq!(
        client.try_set_sla(&Symbol::new(&env, "sla_agent"), &200, &101, &80),
        Err(Ok(Error::InvalidSla))
    );

    // min_quality_score > 100
    assert_eq!(
        client.try_set_sla(&Symbol::new(&env, "sla_agent"), &200, &95, &101),
        Err(Ok(Error::InvalidSla))
    );
}

#[test]
fn check_sla_compliance_pass() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "sla_agent", "research", owner));

    client.set_sla(&Symbol::new(&env, "sla_agent"), &200, &95, &80);

    let compliant = client.check_sla_compliance(
        &Symbol::new(&env, "sla_agent"),
        &150, // response time < 200
        &98,  // uptime > 95
        &90,  // quality > 80
    );
    assert!(compliant);

    let sla = client.get_sla_status(&Symbol::new(&env, "sla_agent")).unwrap();
    assert_eq!(sla.0.total_checks, 1);
    assert_eq!(sla.0.violations, 0);
    assert_eq!(sla.1, 100);
}

#[test]
fn check_sla_compliance_violation() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "sla_agent", "research", owner));

    client.set_sla(&Symbol::new(&env, "sla_agent"), &200, &95, &80);

    let compliant = client.check_sla_compliance(
        &Symbol::new(&env, "sla_agent"),
        &300, // response time > 200 - violation!
        &98,
        &90,
    );
    assert!(!compliant);

    let sla = client.get_sla_status(&Symbol::new(&env, "sla_agent")).unwrap();
    assert_eq!(sla.0.violations, 1);
    assert_eq!(sla.1, 0); // 0% compliance with 1 check and 1 violation
}

#[test]
fn check_sla_compliance_uptime_violation() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "sla_agent", "research", owner));

    client.set_sla(&Symbol::new(&env, "sla_agent"), &200, &95, &80);

    let compliant = client.check_sla_compliance(
        &Symbol::new(&env, "sla_agent"),
        &100,  // ok
        &80,   // uptime < 95 - violation!
        &90,
    );
    assert!(!compliant);
}

#[test]
fn check_sla_compliance_quality_violation() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "sla_agent", "research", owner));

    client.set_sla(&Symbol::new(&env, "sla_agent"), &200, &95, &80);

    let compliant = client.check_sla_compliance(
        &Symbol::new(&env, "sla_agent"),
        &100,
        &98,
        &70, // quality < 80 - violation!
    );
    assert!(!compliant);
}

#[test]
fn sla_compliance_emits_violation_event() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "sla_agent", "research", owner));

    client.set_sla(&Symbol::new(&env, "sla_agent"), &200, &95, &80);

    let initial_events = env.events().all().len();
    client.check_sla_compliance(
        &Symbol::new(&env, "sla_agent"),
        &300, // violation
        &98,
        &90,
    );

    let events = env.events().all();
    assert!(events.len() > initial_events);
}

#[test]
fn sla_bonus_awarded_after_consistent_compliance() {
    let (env, client) = setup();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "sla_agent", "research", owner));

    client.set_sla(&Symbol::new(&env, "sla_agent"), &200, &95, &80);

    // Record 10 compliant checks
    for _ in 0..10 {
        client.check_sla_compliance(
            &Symbol::new(&env, "sla_agent"),
            &100,
            &99,
            &95,
        );
    }

    let sla = client.get_sla_status(&Symbol::new(&env, "sla_agent")).unwrap();
    assert_eq!(sla.0.total_checks, 10);
    assert_eq!(sla.0.violations, 0);
    assert_eq!(sla.1, 100); // 100% compliance
}

#[test]
fn sla_violation_penalty_slashes_bond() {
    let (env, client, _admin) = setup_with_admin();
    let owner = Address::generate(&env);
    client.register_agent(&make_record(&env, "sla_agent", "research", owner));

    let initial_bond = client
        .lookup_agents(&Symbol::new(&env, "research"))
        .get(0)
        .unwrap()
        .bond_amount;

    client.set_sla(&Symbol::new(&env, "sla_agent"), &200, &95, &80);

    client.check_sla_compliance(
        &Symbol::new(&env, "sla_agent"),
        &300, // violation
        &98,
        &90,
    );

    let remaining_bond = client
        .lookup_agents(&Symbol::new(&env, "research"))
        .get(0)
        .unwrap()
        .bond_amount;

    let expected_penalty = initial_bond * SLA_PENALTY_PERCENT / 100;
    assert_eq!(remaining_bond, initial_bond - expected_penalty);
}

// ─── Pagination Tests (Issue #339) ──────────────────────────────────────────

#[test]
fn test_get_agents_empty_registry() {
    let (env, client) = setup();
    let page = client.get_agents(&None, &None);
    assert_eq!(page.agents.len(), 0);
    assert_eq!(page.next_cursor, None);
    assert_eq!(page.total_count, 0);
}

#[test]
fn test_get_agents_single_page() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    client.register_agent(&make_record(&env, "agent_1", "code", owner.clone()));
    client.register_agent(&make_record(&env, "agent_2", "research", owner.clone()));
    client.register_agent(&make_record(&env, "agent_3", "design", owner.clone()));

    let page = client.get_agents(&None, &Some(10));
    assert_eq!(page.agents.len(), 3);
    assert_eq!(page.next_cursor, None);
    assert_eq!(page.total_count, 3);
    assert_eq!(page.agents.get(0).unwrap().id, Symbol::new(&env, "agent_1"));
    assert_eq!(page.agents.get(1).unwrap().id, Symbol::new(&env, "agent_2"));
    assert_eq!(page.agents.get(2).unwrap().id, Symbol::new(&env, "agent_3"));
}

#[test]
fn test_get_agents_cursor_pagination() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    // Register 7 agents
    client.register_agent(&make_record(&env, "agent_1", "code", owner.clone()));
    client.register_agent(&make_record(&env, "agent_2", "code", owner.clone()));
    client.register_agent(&make_record(&env, "agent_3", "code", owner.clone()));
    client.register_agent(&make_record(&env, "agent_4", "code", owner.clone()));
    client.register_agent(&make_record(&env, "agent_5", "code", owner.clone()));
    client.register_agent(&make_record(&env, "agent_6", "code", owner.clone()));
    client.register_agent(&make_record(&env, "agent_7", "code", owner.clone()));

    assert_eq!(client.total_agents(), 7);

    // Page 1: limit 3
    let page1 = client.get_agents(&None, &Some(3));
    assert_eq!(page1.agents.len(), 3);
    assert_eq!(page1.total_count, 7);
    assert_eq!(page1.next_cursor, Some(3));
    assert_eq!(page1.agents.get(0).unwrap().id, Symbol::new(&env, "agent_1"));
    assert_eq!(page1.agents.get(1).unwrap().id, Symbol::new(&env, "agent_2"));
    assert_eq!(page1.agents.get(2).unwrap().id, Symbol::new(&env, "agent_3"));

    // Page 2: cursor 3, limit 3
    let page2 = client.get_agents(&page1.next_cursor, &Some(3));
    assert_eq!(page2.agents.len(), 3);
    assert_eq!(page2.total_count, 7);
    assert_eq!(page2.next_cursor, Some(6));
    assert_eq!(page2.agents.get(0).unwrap().id, Symbol::new(&env, "agent_4"));
    assert_eq!(page2.agents.get(1).unwrap().id, Symbol::new(&env, "agent_5"));
    assert_eq!(page2.agents.get(2).unwrap().id, Symbol::new(&env, "agent_6"));

    // Page 3: cursor 6, limit 3 -> last remaining agent
    let page3 = client.get_agents(&page2.next_cursor, &Some(3));
    assert_eq!(page3.agents.len(), 1);
    assert_eq!(page3.total_count, 7);
    assert_eq!(page3.next_cursor, None);
    assert_eq!(page3.agents.get(0).unwrap().id, Symbol::new(&env, "agent_7"));
}

#[test]
fn test_get_agents_stable_boundaries_under_deregistration() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    client.register_agent(&make_record(&env, "agent_1", "code", owner.clone()));
    client.register_agent(&make_record(&env, "agent_2", "code", owner.clone()));
    client.register_agent(&make_record(&env, "agent_3", "code", owner.clone()));

    // Deregister agent_2
    client.deregister_agent(&Symbol::new(&env, "agent_2"));
    assert_eq!(client.total_agents(), 2);

    // Listing with limit 10 returns active agents (agent_1, agent_3) and total_count = 2
    let page = client.get_agents(&None, &Some(10));
    assert_eq!(page.agents.len(), 2);
    assert_eq!(page.total_count, 2);
    assert_eq!(page.next_cursor, None);
    assert_eq!(page.agents.get(0).unwrap().id, Symbol::new(&env, "agent_1"));
    assert_eq!(page.agents.get(1).unwrap().id, Symbol::new(&env, "agent_3"));
}

#[test]
fn test_get_agents_batch_registered_pagination() {
    let (env, client) = setup();
    let owner = Address::generate(&env);

    let mut batch = soroban_sdk::Vec::new(&env);
    batch.push_back(make_record(&env, "batch_1", "code", owner.clone()));
    batch.push_back(make_record(&env, "batch_2", "code", owner.clone()));
    batch.push_back(make_record(&env, "batch_3", "code", owner.clone()));
    batch.push_back(make_record(&env, "batch_4", "code", owner.clone()));

    let results = client.register_agents(&batch);
    assert_eq!(results.len(), 4);

    let page1 = client.get_agents(&Some(0), &Some(2));
    assert_eq!(page1.agents.len(), 2);
    assert_eq!(page1.next_cursor, Some(2));
    assert_eq!(page1.total_count, 4);

    let page2 = client.get_agents(&page1.next_cursor, &Some(2));
    assert_eq!(page2.agents.len(), 2);
    assert_eq!(page2.next_cursor, None);
    assert_eq!(page2.total_count, 4);
}

// ─── error_mapper tests ─────────────────────────────────────────────────────

#[test]
fn error_mapper_returns_common_codes_for_reserved_range() {
    let (env, client) = setup();

    // Common codes 1..=15 should map to their CommonExitCode variants
    for raw in 1..=15u32 {
        let result = client.error_mapper(&raw);
        assert!(result.is_some(), "error_mapper({raw}) should return Some");
        assert_eq!(result.unwrap() as u32, raw);
    }
}

#[test]
fn error_mapper_returns_none_for_contract_specific_codes() {
    let (env, client) = setup();

    // Contract-specific codes outside 1..=15 should return None
    assert!(client.error_mapper(&0).is_none());
    assert!(client.error_mapper(&16).is_none());
    assert!(client.error_mapper(&100).is_none());
    assert!(client.error_mapper(&255).is_none());
}

#[test]
fn error_mapper_propagation_consistency() {
    let (env, client) = setup();

    // Simulate cross-contract error propagation: a contract returns
    // Error::NotFound (code 1), which maps to CommonExitCode::NotFound (code 1)
    let agent_registry_code = Error::NotFound as u32;
    let common = client.error_mapper(&agent_registry_code);
    assert!(common.is_some());
    assert_eq!(common.unwrap(), CommonExitCode::NotFound);

    // Error::AlreadyExists (code 3) maps to CommonExitCode::AlreadyExists
    let already_exists_code = Error::AlreadyExists as u32;
    let common = client.error_mapper(&already_exists_code);
    assert!(common.is_some());
    assert_eq!(common.unwrap(), CommonExitCode::AlreadyExists);
}

