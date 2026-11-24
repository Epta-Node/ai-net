//! Gas snapshots for the sealed-bid hot paths (Issue #773).

use agent_bidding::{AgentBiddingContract, AgentBiddingContractClient, AuctionConfig};
use contract_test_utils::gas::{assert_snapshot, reset};
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

#[test]
fn bidding_gas_snapshots() {
    let (env, client, asset) = setup();
    let creator = Address::generate(&env);
    let bidder = Address::generate(&env);
    fund(&env, &asset, &creator, 10_000_000);
    fund(&env, &asset, &bidder, 500_000);

    let task_id = Symbol::new(&env, "gas_auc");
    reset(&env);
    client.create_auction(
        &creator,
        &task_id,
        &AuctionConfig {
            duration_secs: 3_600,
            reveal_duration_secs: 3_600,
            reserve_price: 1_000_000,
            max_price: 10_000_000,
            bond: 500_000,
        },
    );
    assert_snapshot(&env, "agent_bidding", "create_auction");

    let salt = BytesN::from_array(&env, &[1u8; 32]);
    let terms = String::from_str(&env, "Fast execution");
    let price = 3_000_000;
    let commitment = client.commitment_of(&task_id, &bidder, &price, &terms, &salt);

    reset(&env);
    client.submit_bid(&task_id, &bidder, &commitment, &500_000, &85);
    assert_snapshot(&env, "agent_bidding", "submit_bid");

    env.ledger().set_timestamp(env.ledger().timestamp() + 3_601);
    reset(&env);
    client.reveal_bid(&task_id, &bidder, &price, &terms, &salt);
    assert_snapshot(&env, "agent_bidding", "reveal_bid");
}
