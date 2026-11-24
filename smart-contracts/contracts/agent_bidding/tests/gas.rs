use agent_bidding::{AgentBiddingContract, AuctionConfig};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, BytesN, Env, String, Symbol,
};

#[test]
fn estimates_are_within_twenty_percent_for_bid_and_reveal() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentBiddingContract, ());
    let client = agent_bidding::AgentBiddingContractClient::new(&env, &id);
    let creator = Address::generate(&env);
    let task = Symbol::new(&env, "gas_task");
    let bidder = Address::generate(&env);
    let bidder2 = Address::generate(&env);
    client.create_auction(
        &creator,
        &task,
        &AuctionConfig {
            duration_secs: 60,
            reveal_duration_secs: 600,
            reserve_price: 1_000_000,
            max_price: 10_000_000,
            bond: 500_000,
        },
    );

    let price = 2_000_000i128;
    let terms = String::from_str(&env, "terms");
    let salt = BytesN::from_array(&env, &[9; 32]);
    let commitment = client.commitment_of(&task, &bidder, &price, &terms, &salt);
    env.cost_estimate().budget().reset_tracker();
    client.submit_bid(&task, &bidder, &commitment, &500_000, &70);
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&Symbol::new(&env, "bid"), &1);
    std::println!("bid estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);

    let salt2 = BytesN::from_array(&env, &[8; 32]);
    let commitment2 = client.commitment_of(&task, &bidder2, &price, &terms, &salt2);
    client.submit_bid(&task, &bidder2, &commitment2, &500_000, &65);

    env.ledger().with_mut(|ledger| ledger.timestamp += 60);
    env.cost_estimate().budget().reset_tracker();
    client.reveal_bid(&task, &bidder, &price, &terms, &salt);
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&Symbol::new(&env, "reveal"), &1);
    std::println!("reveal estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);

    client.reveal_bid(&task, &bidder2, &price, &terms, &salt2);
    env.cost_estimate().budget().reset_tracker();
    client.reveal_bids(&Address::generate(&env), &task);
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&Symbol::new(&env, "finalize"), &2);
    std::println!("reveal batch estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);
}

fn assert_within_twenty_percent(estimate: u64, actual: u64) {
    assert!(actual > 0);
    assert!(estimate.saturating_mul(100) >= actual.saturating_mul(80));
    assert!(estimate.saturating_mul(100) <= actual.saturating_mul(120));
}
