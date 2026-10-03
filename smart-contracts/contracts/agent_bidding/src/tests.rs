//! # Agent Bidding Contract Unit Tests
//!
//! Comprehensive unit tests covering every public function, error case, edge case,
//! and event emission for `AgentBiddingContract`.

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, String, Symbol,
};

fn setup() -> (Env, AgentBiddingContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentBiddingContract, ());
    let client = AgentBiddingContractClient::new(&env, &id);
    (env, client)
}

fn setup_with_admin() -> (Env, AgentBiddingContractClient<'static>, Address) {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

fn create_default_auction(
    _env: &Env,
    client: &AgentBiddingContractClient<'_>,
    creator: &Address,
    task_id: &Symbol,
) {
    client.create_auction(
        creator,
        task_id,
        &AuctionConfig {
            duration_secs: 3600,
            reveal_duration_secs: 3600,
            reserve_price: 1_000_000,
            max_price: 10_000_000,
            bond: 500_000,
        },
    );
}

// ─── Initialize & Admin ──────────────────────────────────────────────────────

#[test]
fn initialize_sets_admin_and_version() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    assert!(client.try_initialize(&admin).is_ok());

    assert_eq!(client.admin(), Some(admin));
    assert_eq!(
        client.contract_version(),
        String::from_str(&env, CONTRACT_VERSION)
    );
}

#[test]
fn initialize_cannot_be_called_twice() {
    let (_env, client, admin) = setup_with_admin();
    let err = client.try_initialize(&admin);
    assert_eq!(err, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn admin_query_returns_none_when_uninitialized() {
    let (_env, client) = setup();
    assert_eq!(client.admin(), None);
}

// ─── Pause & Unpause ─────────────────────────────────────────────────────────

#[test]
fn admin_can_pause_and_unpause() {
    let (_env, client, admin) = setup_with_admin();
    assert!(!client.is_paused());

    client.set_paused(&admin, &true);
    assert!(client.is_paused());

    client.set_paused(&admin, &false);
    assert!(!client.is_paused());
}

#[test]
fn non_admin_cannot_pause() {
    let (env, client, _admin) = setup_with_admin();
    let stranger = Address::generate(&env);
    let err = client.try_set_paused(&stranger, &true);
    assert_eq!(err, Err(Ok(Error::Unauthorized)));
}

// ─── Contract Upgrade ────────────────────────────────────────────────────────

#[test]
fn upgrade_contract_version() {
    let (env, client, _admin) = setup_with_admin();
    let dummy_wasm_hash = env
        .deployer()
        .upload_contract_wasm(soroban_sdk::Bytes::new(&env));
    let new_ver = String::from_str(&env, "2.0.0");

    assert!(client.try_upgrade(&dummy_wasm_hash, &new_ver).is_ok());
    assert_eq!(client.contract_version(), new_ver);
}

// ─── Create Auction ──────────────────────────────────────────────────────────

#[test]
fn create_auction_success_and_events() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_1");

    client.create_auction(
        &creator,
        &task_id,
        &AuctionConfig {
            duration_secs: 3600,
            reveal_duration_secs: 1800,
            reserve_price: 1_000_000,
            max_price: 5_000_000,
            bond: 200_000,
        },
    );

    let auction = client.get_auction(&task_id).unwrap();
    assert_eq!(auction.task_id, task_id);
    assert_eq!(auction.creator, creator);
    assert_eq!(auction.config.reserve_price, 1_000_000);
    assert_eq!(auction.config.max_price, 5_000_000);
    assert_eq!(auction.config.bond, 200_000);
    assert_eq!(auction.phase, AuctionPhase::Bidding);
    assert_eq!(auction.bid_count, 0);
}

#[test]
fn create_auction_defaults_on_zero_durations_and_max_price() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_def");

    client.create_auction(
        &creator,
        &task_id,
        &AuctionConfig {
            duration_secs: 0,
            reveal_duration_secs: 0,
            reserve_price: 1_000_000,
            max_price: 0,
            bond: 100_000,
        },
    );

    let auction = client.get_auction(&task_id).unwrap();
    assert_eq!(auction.config.duration_secs, DEFAULT_BIDDING_DURATION_SECS);
    assert_eq!(
        auction.config.reveal_duration_secs,
        DEFAULT_REVEAL_DURATION_SECS
    );
    assert_eq!(auction.config.max_price, MAX_BID_PRICE);
}

#[test]
fn create_auction_duplicate_id_fails() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_dup");

    create_default_auction(&env, &client, &creator, &task_id);

    let err = client.try_create_auction(
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
    assert_eq!(err, Err(Ok(Error::AlreadyExists)));
}

#[test]
fn create_auction_invalid_bond_or_price() {
    let (env, client) = setup();
    let creator = Address::generate(&env);

    // Zero / negative bond
    let err = client.try_create_auction(
        &creator,
        &Symbol::new(&env, "t1"),
        &AuctionConfig {
            duration_secs: 3600,
            reveal_duration_secs: 3600,
            reserve_price: 1_000_000,
            max_price: 10_000_000,
            bond: 0,
        },
    );
    assert_eq!(err, Err(Ok(Error::InvalidBond)));

    // Zero / negative reserve price
    let err = client.try_create_auction(
        &creator,
        &Symbol::new(&env, "t2"),
        &AuctionConfig {
            duration_secs: 3600,
            reveal_duration_secs: 3600,
            reserve_price: 0,
            max_price: 10_000_000,
            bond: 500_000,
        },
    );
    assert_eq!(err, Err(Ok(Error::InvalidPrice)));

    // max_price < reserve_price
    let err = client.try_create_auction(
        &creator,
        &Symbol::new(&env, "t3"),
        &AuctionConfig {
            duration_secs: 3600,
            reveal_duration_secs: 3600,
            reserve_price: 5_000_000,
            max_price: 4_000_000,
            bond: 500_000,
        },
    );
    assert_eq!(err, Err(Ok(Error::InvalidPriceRange)));
}

#[test]
fn create_auction_fails_when_paused() {
    let (env, client, admin) = setup_with_admin();
    client.set_paused(&admin, &true);

    let creator = Address::generate(&env);
    let err = client.try_create_auction(
        &creator,
        &Symbol::new(&env, "t_paused"),
        &AuctionConfig {
            duration_secs: 3600,
            reveal_duration_secs: 3600,
            reserve_price: 1_000_000,
            max_price: 10_000_000,
            bond: 500_000,
        },
    );
    assert_eq!(err, Err(Ok(Error::ContractPaused)));
}

// ─── Submit Bid ──────────────────────────────────────────────────────────────

#[test]
fn submit_bid_success() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_bid1");

    create_default_auction(&env, &client, &creator, &task_id);

    let salt = BytesN::from_array(&env, &[1u8; 32]);
    let terms = String::from_str(&env, "Fast execution");
    let comm = client.commitment_of(&task_id, &bidder, &2_000_000, &terms, &salt);

    let res = client.try_submit_bid(&task_id, &bidder, &comm, &500_000, &85);
    assert!(res.is_ok());

    let bid = client.get_bid(&task_id, &bidder).unwrap();
    assert_eq!(bid.bidder, bidder);
    assert_eq!(bid.commitment, comm);
    assert_eq!(bid.bond, 500_000);
    assert_eq!(bid.reputation, 85);
    assert!(!bid.revealed);

    let bidders = client.get_bidders(&task_id, &0, &10);
    assert_eq!(bidders.len(), 1);
    assert_eq!(bidders.get(0).unwrap(), bidder);
}

#[test]
fn submit_bid_errors() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_bid_err");

    create_default_auction(&env, &client, &creator, &task_id);

    let salt = BytesN::from_array(&env, &[1u8; 32]);
    let terms = String::from_str(&env, "");
    let comm = client.commitment_of(&task_id, &bidder, &2_000_000, &terms, &salt);

    // Invalid bond
    assert_eq!(
        client.try_submit_bid(&task_id, &bidder, &comm, &100_000, &50),
        Err(Ok(Error::InvalidBond))
    );

    // Invalid reputation (> 100)
    assert_eq!(
        client.try_submit_bid(&task_id, &bidder, &comm, &500_000, &101),
        Err(Ok(Error::InvalidReputation))
    );

    // Zero commitment
    let zero_comm = BytesN::from_array(&env, &[0u8; 32]);
    assert_eq!(
        client.try_submit_bid(&task_id, &bidder, &zero_comm, &500_000, &50),
        Err(Ok(Error::InvalidCommitment))
    );

    // Valid submission
    client.submit_bid(&task_id, &bidder, &comm, &500_000, &50);

    // Duplicate submission
    assert_eq!(
        client.try_submit_bid(&task_id, &bidder, &comm, &500_000, &50),
        Err(Ok(Error::BidAlreadyExists))
    );

    // Submission after deadline
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    let bidder2 = Address::generate(&env);
    let comm2 = client.commitment_of(&task_id, &bidder2, &2_000_000, &terms, &salt);
    assert_eq!(
        client.try_submit_bid(&task_id, &bidder2, &comm2, &500_000, &50),
        Err(Ok(Error::BiddingPeriodEnded))
    );
}

// ─── Reveal Bid ──────────────────────────────────────────────────────────────

#[test]
fn reveal_bid_success() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_rvl");

    create_default_auction(&env, &client, &creator, &task_id);

    let salt = BytesN::from_array(&env, &[2u8; 32]);
    let terms = String::from_str(&env, "Terms details");
    let price: i128 = 3_000_000;
    let comm = client.commitment_of(&task_id, &bidder, &price, &terms, &salt);

    client.submit_bid(&task_id, &bidder, &comm, &500_000, &90);

    // Advance timestamp into reveal window
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

    let res = client.try_reveal_bid(&task_id, &bidder, &price, &terms, &salt);
    assert!(res.is_ok());

    let bid = client.get_bid(&task_id, &bidder).unwrap();
    assert!(bid.revealed);
    assert_eq!(bid.price_stroops, price);
    assert_eq!(bid.terms, terms);
}

#[test]
fn reveal_bid_errors() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_rvl_err");

    create_default_auction(&env, &client, &creator, &task_id);

    let salt = BytesN::from_array(&env, &[2u8; 32]);
    let terms = String::from_str(&env, "Terms");
    let price: i128 = 3_000_000;
    let comm = client.commitment_of(&task_id, &bidder, &price, &terms, &salt);

    client.submit_bid(&task_id, &bidder, &comm, &500_000, &90);

    // Reveal too early (bidding active)
    assert_eq!(
        client.try_reveal_bid(&task_id, &bidder, &price, &terms, &salt),
        Err(Ok(Error::BiddingPeriodActive))
    );

    // Advance into reveal window
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

    // Wrong commitment / incorrect price during reveal
    assert_eq!(
        client.try_reveal_bid(&task_id, &bidder, &4_000_000, &terms, &salt),
        Err(Ok(Error::InvalidCommitment))
    );

    // Reveal after reveal_deadline
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    assert_eq!(
        client.try_reveal_bid(&task_id, &bidder, &price, &terms, &salt),
        Err(Ok(Error::RevealPeriodEnded))
    );
}

// ─── Reveal Bids & Winner Selection ──────────────────────────────────────────

#[test]
fn reveal_bids_selects_highest_score_and_tie_break() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_winner");

    create_default_auction(&env, &client, &creator, &task_id);

    let bidder1 = Address::generate(&env);
    let bidder2 = Address::generate(&env);

    // Bidder 1: price 5M, reputation 80
    let salt1 = BytesN::from_array(&env, &[1u8; 32]);
    let terms1 = String::from_str(&env, "");
    let comm1 = client.commitment_of(&task_id, &bidder1, &5_000_000, &terms1, &salt1);
    client.submit_bid(&task_id, &bidder1, &comm1, &500_000, &80);

    // Bidder 2: price 3M, reputation 80 (lower price should win tie-break)
    let salt2 = BytesN::from_array(&env, &[2u8; 32]);
    let terms2 = String::from_str(&env, "");
    let comm2 = client.commitment_of(&task_id, &bidder2, &3_000_000, &terms2, &salt2);
    client.submit_bid(&task_id, &bidder2, &comm2, &500_000, &80);

    // Advance time and reveal both
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    client.reveal_bid(&task_id, &bidder1, &5_000_000, &terms1, &salt1);
    client.reveal_bid(&task_id, &bidder2, &3_000_000, &terms2, &salt2);

    // Finalize reveals
    client.reveal_bids(&creator, &task_id);

    let auction = client.get_auction(&task_id).unwrap();
    assert_eq!(auction.phase, AuctionPhase::Reveal);

    let winner = client.get_winner(&task_id).unwrap();
    assert_eq!(winner, bidder2);
}

#[test]
fn reveal_bids_fails_when_no_bids_revealed() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_no_rvl");

    create_default_auction(&env, &client, &creator, &task_id);

    // Advance past reveal window
    env.ledger().set_timestamp(env.ledger().timestamp() + 7201);

    let err = client.try_reveal_bids(&creator, &task_id);
    assert_eq!(err, Err(Ok(Error::NotEnoughBids)));
}

// ─── Claim Refund & Award Contract ───────────────────────────────────────────

#[test]
fn claim_bid_refund_and_award_contract_flow() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_award");

    create_default_auction(&env, &client, &creator, &task_id);

    let winner_addr = Address::generate(&env);
    let loser_addr = Address::generate(&env);

    // Winner bid: 2M
    let salt1 = BytesN::from_array(&env, &[1u8; 32]);
    let terms1 = String::from_str(&env, "");
    let comm1 = client.commitment_of(&task_id, &winner_addr, &2_000_000, &terms1, &salt1);
    client.submit_bid(&task_id, &winner_addr, &comm1, &500_000, &90);

    // Loser bid: 8M
    let salt2 = BytesN::from_array(&env, &[2u8; 32]);
    let terms2 = String::from_str(&env, "");
    let comm2 = client.commitment_of(&task_id, &loser_addr, &8_000_000, &terms2, &salt2);
    client.submit_bid(&task_id, &loser_addr, &comm2, &500_000, &50);

    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    client.reveal_bid(&task_id, &winner_addr, &2_000_000, &terms1, &salt1);
    client.reveal_bid(&task_id, &loser_addr, &8_000_000, &terms2, &salt2);

    client.reveal_bids(&creator, &task_id);

    // Loser claims refund
    assert!(client.try_claim_bid_refund(&task_id, &loser_addr).is_ok());

    // Winner cannot claim refund via claim_bid_refund path
    assert_eq!(
        client.try_claim_bid_refund(&task_id, &winner_addr),
        Err(Ok(Error::WinnerCannotClaimRefund))
    );

    // Award contract
    assert!(client.try_award_contract(&creator, &task_id).is_ok());

    let auction = client.get_auction(&task_id).unwrap();
    assert_eq!(auction.phase, AuctionPhase::Awarded);

    let escrow = client.get_escrow(&task_id).unwrap();
    assert_eq!(escrow.agent, winner_addr);
    assert_eq!(escrow.amount, 2_000_000);

    // Awarding twice fails
    assert_eq!(
        client.try_award_contract(&creator, &task_id),
        Err(Ok(Error::AlreadyAwarded))
    );
}

// ─── Abort Auction ───────────────────────────────────────────────────────────

#[test]
fn abort_auction_when_no_reveals() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_abort");

    create_default_auction(&env, &client, &creator, &task_id);

    let salt = BytesN::from_array(&env, &[1u8; 32]);
    let terms = String::from_str(&env, "");
    let comm = client.commitment_of(&task_id, &bidder, &2_000_000, &terms, &salt);
    client.submit_bid(&task_id, &bidder, &comm, &500_000, &50);

    // Calling abort while reveal period active fails
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);
    assert_eq!(
        client.try_abort_auction(&creator, &task_id),
        Err(Ok(Error::RevealPeriodActive))
    );

    // Advance past reveal deadline
    env.ledger().set_timestamp(env.ledger().timestamp() + 3601);

    assert!(client.try_abort_auction(&creator, &task_id).is_ok());

    let auction = client.get_auction(&task_id).unwrap();
    assert_eq!(auction.phase, AuctionPhase::Cancelled);

    let bid = client.get_bid(&task_id, &bidder).unwrap();
    assert!(bid.refunded);
}

// ─── Pagination ──────────────────────────────────────────────────────────────

#[test]
fn get_bidders_pagination_limits() {
    let (env, client) = setup();
    let creator = Address::generate(&env);
    let task_id = Symbol::new(&env, "task_page");

    create_default_auction(&env, &client, &creator, &task_id);

    // Page size > MAX_PAGE_SIZE (50) is clamped to MAX_PAGE_SIZE and succeeds
    let bidders = client.get_bidders(&task_id, &0, &51);
    assert_eq!(bidders.len(), 0);
}
