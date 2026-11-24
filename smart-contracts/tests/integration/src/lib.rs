//! # Cross-Contract Integration Tests
//!
//! Tests end-to-end workflows across multiple smart contracts (registry, bidding,
//! marketplace, task store, dispute resolution, oracle manager, price oracle).

#![cfg(test)]

extern crate std;

use agent_bidding::{
    AgentBiddingContract, AgentBiddingContractClient, AuctionConfig, AuctionPhase,
};
use agent_marketplace::{AgentMarketplaceContract, AgentMarketplaceContractClient};
use agent_registry::{AgentRegistryContract, AgentRegistryContractClient};
use dispute_resolution::{
    DisputeResolutionContract, DisputeResolutionContractClient, DisputeStatus, VoteSide,
};
use oracle_manager::{OracleManagerContract, OracleManagerContractClient};
use price_oracle::{PriceOracleContract, PriceOracleContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, String, Symbol, Vec,
};
use task_store::{TaskStatus, TaskStoreContract, TaskStoreContractClient};

/// Full end-to-end flow: Registry -> Bidding -> Escrow Award
#[test]
fn test_flow_registry_to_bidding_and_escrow() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    // Register Contracts
    let reg_id = env.register(AgentRegistryContract, ());
    let reg_client = AgentRegistryContractClient::new(&env, &reg_id);

    let bidding_id = env.register(AgentBiddingContract, ());
    let bidding_client = AgentBiddingContractClient::new(&env, &bidding_id);

    let admin = Address::generate(&env);
    reg_client.initialize(&admin, &100_000i128, &86_400u64, &50u32);
    bidding_client.initialize(&admin);

    let agent_owner = Address::generate(&env);
    let agent_id = Symbol::new(&env, "agent_1");

    // 1. Agent registers on-chain
    reg_client.register_agent(
        &agent_owner,
        &agent_id,
        &Symbol::new(&env, "coding"),
        &String::from_str(&env, "ipfs://metadata"),
    );

    // 2. Creator creates bidding auction
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_auc_1");
    bidding_client.create_auction(
        &creator,
        &task_id,
        &AuctionConfig {
            duration_secs: 3600,
            reveal_duration_secs: 3600,
            reserve_price: 1_000_000,
            max_price: 10_000_000,
            bond: 500_000,
        },
    );

    // 3. Agent submits sealed bid
    let salt = BytesN::from_array(&env, &[42u8; 32]);
    let terms = String::from_str(&env, "Completed in 2 hours");
    let price: i128 = 2_500_000;
    let comm = bidding_client.commitment_of(&task_id, &agent_owner, &price, &terms, &salt);
    bidding_client.submit_bid(&task_id, &agent_owner, &comm, &500_000, &95);

    // 4. Advance time to reveal window & reveal
    env.ledger().set_timestamp(1_700_000_000 + 3601);
    bidding_client.reveal_bid(&task_id, &agent_owner, &price, &terms, &salt);

    // 5. Select winner & award contract
    bidding_client.reveal_bids(&creator, &task_id);
    bidding_client.award_contract(&creator, &task_id);

    // Verify auction awarded and escrow recorded
    let auction = bidding_client.get_auction(&task_id).unwrap();
    assert_eq!(auction.phase, AuctionPhase::Awarded);

    let escrow = bidding_client.get_escrow(&task_id).unwrap();
    assert_eq!(escrow.agent, agent_owner);
    assert_eq!(escrow.amount, price);
}

/// Full end-to-end flow: Registry -> Marketplace -> Booking -> Completion & Rating
#[test]
fn test_flow_registry_to_marketplace_and_payment() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let reg_id = env.register(AgentRegistryContract, ());
    let reg_client = AgentRegistryContractClient::new(&env, &reg_id);

    let market_id = env.register(AgentMarketplaceContract, ());
    let market_client = AgentMarketplaceContractClient::new(&env, &market_id);

    let admin = Address::generate(&env);
    reg_client.initialize(&admin, &100_000i128, &86_400u64, &50u32);
    market_client.initialize(&admin);

    let agent_owner = Address::generate(&env);
    let agent_id = Symbol::new(&env, "expert_agent");

    // 1. Register agent
    reg_client.register_agent(
        &agent_owner,
        &agent_id,
        &Symbol::new(&env, "research"),
        &String::from_str(&env, "ipfs://meta"),
    );

    // 2. List service on marketplace
    let listing_id = Symbol::new(&env, "svc_research_1");
    market_client.list_service(
        &listing_id,
        &agent_id,
        &agent_owner,
        &Symbol::new(&env, "research"),
        &1_500_000i128,
        &120u32,
        &24u32,
    );

    // 3. Client searches service & books agent
    let client_addr = Address::generate(&env);
    let results =
        market_client.search_services(&Symbol::new(&env, "research"), &2_000_000i128, &200u32);
    assert_eq!(results.len(), 1);

    let booking_id = Symbol::new(&env, "book_1");
    market_client.book_agent(&listing_id, &client_addr, &1_500_000i128, &booking_id);

    let booking = market_client.get_booking(&booking_id).unwrap();
    assert_eq!(booking.escrow_amount, 1_500_000);
    assert!(!booking.completed);

    // 4. Agent completes service & client rates
    market_client.complete_booking(&booking_id);
    let completed_booking = market_client.get_booking(&booking_id).unwrap();
    assert!(completed_booking.completed);

    market_client.rate_booking(&booking_id, &5u32);
    let rating = market_client.get_agent_rating(&agent_id);
    assert_eq!(rating.total_ratings, 1);
    assert_eq!(rating.rating_sum, 5);
}

/// Full end-to-end flow: Price Oracle -> Oracle Manager -> Task Store Metadata Pricing
#[test]
fn test_flow_oracle_to_task_store() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    // Deploy PriceOracle
    let oracle_id = env.register(PriceOracleContract, ());
    let oracle_client = PriceOracleContractClient::new(&env, &oracle_id);
    let admin = Address::generate(&env);
    oracle_client.initialize(&admin, &3600u64);

    let pair = Symbol::new(&env, "XLM_USD");
    oracle_client.submit_price(&pair, &12_500_000i128, &1_700_000_000);

    // Deploy OracleManager
    let mgr_id = env.register(OracleManagerContract, ());
    let mgr_client = OracleManagerContractClient::new(&env, &mgr_id);
    mgr_client.initialize(&admin);
    mgr_client.set_oracle(&Some(oracle_id));

    // Deploy TaskStore and wire OracleManager
    let task_store_id = env.register(TaskStoreContract, ());
    let task_store_client = TaskStoreContractClient::new(&env, &task_store_id);
    task_store_client.initialize(&admin);
    task_store_client.set_oracle_manager(&Some(mgr_id.clone()));

    // Store task metadata with price pair
    let submitter = Address::generate(&env);
    let agent = Address::generate(&env);
    let task_id = BytesN::from_array(&env, &[100u8; 32]);
    let prompt_hash = BytesN::from_array(&env, &[101u8; 32]);
    let agents = Vec::from_array(&env, [agent.clone()]);
    let dag = soroban_sdk::Bytes::from_slice(&env, &[0x78, 0x9c, 0x01]);

    task_store_client.store_task_metadata(
        &submitter,
        &task_id,
        &prompt_hash,
        &agents,
        &dag,
        &7u32,
        &Some(pair.clone()),
    );

    let meta = task_store_client.get_task_metadata(&task_id).unwrap();
    assert_eq!(meta.quoted_price_stroops, Some(12_500_000i128));
    assert_eq!(meta.price_pair, Some(pair));

    // Update status
    task_store_client.update_task_status(&task_id, &agent, &TaskStatus::Running);
    assert_eq!(
        task_store_client.get_task_status(&task_id).unwrap(),
        TaskStatus::Running
    );
}

/// Full end-to-end flow: Dispute Filing -> Evidence -> Juror Voting -> Resolution & Appeal
#[test]
fn test_flow_dispute_resolution_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let dispute_id = env.register(DisputeResolutionContract, ());
    let client = DisputeResolutionContractClient::new(&env, &dispute_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let jurors = soroban_sdk::vec![
        &env,
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    client.set_jurors(&jurors);

    let filer = Address::generate(&env);
    let agent_id = Symbol::new(&env, "faulty_agent");
    let d_id = Symbol::new(&env, "disp_100");

    // 1. File dispute
    client.file_dispute(&filer, &agent_id, &d_id);
    let dispute = client.get_dispute(&d_id).unwrap();
    assert_eq!(dispute.status, DisputeStatus::Filed);

    // 2. Submit evidence
    let ev_hash = BytesN::from_array(&env, &[99u8; 32]);
    client.submit_evidence(&d_id, &filer, &ev_hash);
    assert_eq!(client.get_evidence_count(&d_id), 1);

    // 3. Jurors vote (3 for Client, 2 for Agent)
    client.cast_vote(&d_id, &jurors.get(0).unwrap(), &VoteSide::Client);
    client.cast_vote(&d_id, &jurors.get(1).unwrap(), &VoteSide::Client);
    client.cast_vote(&d_id, &jurors.get(2).unwrap(), &VoteSide::Client);
    client.cast_vote(&d_id, &jurors.get(3).unwrap(), &VoteSide::Agent);
    client.cast_vote(&d_id, &jurors.get(4).unwrap(), &VoteSide::Agent);

    // 4. Advance past voting deadline & resolve
    env.ledger()
        .set_timestamp(1_700_000_000 + 259_200 + 172_800 + 1);
    client.resolve_dispute(&d_id);

    let resolved = client.get_dispute(&d_id).unwrap();
    assert_eq!(resolved.status, DisputeStatus::Resolved);
    assert_eq!(resolved.resolution, Some(0)); // Client won

    // 5. Appeal dispute within appeal window
    let appellant = Address::generate(&env);
    client.appeal_dispute(&d_id, &appellant);

    let appealed = client.get_dispute(&d_id).unwrap();
    assert_eq!(appealed.status, DisputeStatus::Appealed);
    assert!(appealed.appealed);
}
