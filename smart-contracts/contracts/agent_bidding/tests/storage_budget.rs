//! Storage-budget assertions for the sealed-bid hot paths (Issue #771).

use agent_bidding::{AgentBiddingContract, AgentBiddingContractClient, AuctionConfig};
use contract_test_utils::{assert_storage_within, StorageBudget};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, String, Symbol,
};

fn setup() -> (Env, AgentBiddingContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentBiddingContract, ());
    let client = AgentBiddingContractClient::new(&env, &id);
    client.initialize(&Address::generate(&env));
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    client.set_payment_asset(&sac.address(), &7);
    (env, client, sac.address())
}

fn fund(env: &Env, asset: &Address, who: &Address, amount: i128) {
    soroban_sdk::token::StellarAssetClient::new(env, asset).mint(who, &amount);
}

fn auction_config() -> AuctionConfig {
    AuctionConfig {
        duration_secs: 3_600,
        reveal_duration_secs: 3_600,
        reserve_price: 1_000_000,
        max_price: 10_000_000,
        bond: 500_000,
    }
}

/// One auction writes the auction record, its bidder list and the phase/index
/// bookkeeping. Measured: +3 entries / +812 bytes. Ceiling: 3 / 900.
#[test]
fn create_auction_stays_within_storage_budget() {
    let (env, client, asset) = setup();
    let creator = Address::generate(&env);
    fund(&env, &asset, &creator, 10_000_000);
    let task_id = Symbol::new(&env, "budget_auc");

    assert_storage_within(
        &env,
        &client.address,
        "agent_bidding::create_auction",
        StorageBudget::new(3, 900),
        || client.create_auction(&creator, &task_id, &auction_config()),
    );
}

/// A sealed bid adds the bid record, the bidder index entry and the bidder
/// list. Measured: +1 entry / +492 bytes. Ceiling: 1 / 500.
#[test]
fn submit_bid_stays_within_storage_budget() {
    let (env, client, asset) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    fund(&env, &asset, &creator, 10_000_000);
    fund(&env, &asset, &bidder, 500_000);
    let task_id = Symbol::new(&env, "budget_bid");
    client.create_auction(&creator, &task_id, &auction_config());

    let salt = BytesN::from_array(&env, &[1u8; 32]);
    let terms = String::from_str(&env, "Fast execution");
    let commitment = client.commitment_of(&task_id, &bidder, &2_000_000, &terms, &salt);

    assert_storage_within(
        &env,
        &client.address,
        "agent_bidding::submit_bid",
        StorageBudget::new(1, 500),
        || client.submit_bid(&task_id, &bidder, &commitment, &500_000, &85),
    );
}

/// Revealing an existing bid overwrites its record in place. Measured: +0
/// entries / +16 bytes. Ceiling: 0 / 32.
#[test]
fn reveal_bid_stays_within_storage_budget() {
    let (env, client, asset) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    fund(&env, &asset, &creator, 10_000_000);
    fund(&env, &asset, &bidder, 500_000);
    let task_id = Symbol::new(&env, "budget_rvl");
    client.create_auction(&creator, &task_id, &auction_config());

    let salt = BytesN::from_array(&env, &[2u8; 32]);
    let terms = String::from_str(&env, "Terms details");
    let price = 3_000_000;
    let commitment = client.commitment_of(&task_id, &bidder, &price, &terms, &salt);
    client.submit_bid(&task_id, &bidder, &commitment, &500_000, &90);
    env.ledger().set_timestamp(env.ledger().timestamp() + 3_601);

    assert_storage_within(
        &env,
        &client.address,
        "agent_bidding::reveal_bid",
        StorageBudget::new(0, 32),
        || client.reveal_bid(&task_id, &bidder, &price, &terms, &salt),
    );
}
