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

/// Test gas estimation for finalizing an auction with 1 bidder.
#[test]
fn finalize_auction_with_1_bidder() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentBiddingContract, ());
    let client = agent_bidding::AgentBiddingContractClient::new(&env, &id);
    let creator = Address::generate(&env);
    let task = Symbol::new(&env, "gas_1bid");
    
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

    // Submit 1 bid
    let bidder = Address::generate(&env);
    let price = 2_000_000i128;
    let terms = String::from_str(&env, "terms");
    let salt = BytesN::from_array(&env, &[1; 32]);
    let commitment = client.commitment_of(&task, &bidder, &price, &terms, &salt);
    client.submit_bid(&task, &bidder, &commitment, &500_000, &70);

    // Advance to reveal phase
    env.ledger().with_mut(|ledger| ledger.timestamp += 60);
    
    // Reveal the bid
    client.reveal_bid(&task, &bidder, &price, &terms, &salt);
    
    // Advance past reveal deadline
    env.ledger().with_mut(|ledger| ledger.timestamp += 600);
    
    // Measure gas for finalization
    env.cost_estimate().budget().reset_tracker();
    client.reveal_bids(&Address::generate(&env), &task);
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&Symbol::new(&env, "finalize"), &1);
    
    std::println!("finalize_auction (1 bidder): estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);
}

/// Test gas estimation for finalizing an auction with 10 bidders.
#[test]
fn finalize_auction_with_10_bidders() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentBiddingContract, ());
    let client = agent_bidding::AgentBiddingContractClient::new(&env, &id);
    let creator = Address::generate(&env);
    let task = Symbol::new(&env, "gas_10bids");
    
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

    // Submit 10 bids
    let mut bidders = vec![];
    for i in 0..10 {
        let bidder = Address::generate(&env);
        let price = 1_500_000i128 + (i as i128 * 100_000);
        let terms = String::from_str(&env, "terms");
        let mut salt_bytes = [0u8; 32];
        salt_bytes[0] = i as u8;
        let salt = BytesN::from_array(&env, &salt_bytes);
        let commitment = client.commitment_of(&task, &bidder, &price, &terms, &salt);
        client.submit_bid(&task, &bidder, &commitment, &500_000, &(70 + i));
        bidders.push((bidder, price, salt));
    }

    // Advance to reveal phase
    env.ledger().with_mut(|ledger| ledger.timestamp += 60);
    
    // Reveal all bids
    for (bidder, price, salt) in bidders.iter() {
        let terms = String::from_str(&env, "terms");
        client.reveal_bid(&task, bidder, price, &terms, salt);
    }
    
    // Advance past reveal deadline
    env.ledger().with_mut(|ledger| ledger.timestamp += 600);
    
    // Measure gas for finalization
    env.cost_estimate().budget().reset_tracker();
    client.reveal_bids(&Address::generate(&env), &task);
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&Symbol::new(&env, "finalize"), &10);
    
    std::println!("finalize_auction (10 bidders): estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);
}

/// Test gas estimation for finalizing an auction with 50 bidders.
#[test]
fn finalize_auction_with_50_bidders() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentBiddingContract, ());
    let client = agent_bidding::AgentBiddingContractClient::new(&env, &id);
    let creator = Address::generate(&env);
    let task = Symbol::new(&env, "gas_50bids");
    
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

    // Submit 50 bids
    let mut bidders = vec![];
    for i in 0..50 {
        let bidder = Address::generate(&env);
        let price = 1_500_000i128 + (i as i128 * 50_000);
        let terms = String::from_str(&env, "terms");
        let mut salt_bytes = [0u8; 32];
        salt_bytes[0] = i as u8;
        salt_bytes[1] = (i / 256) as u8;
        let salt = BytesN::from_array(&env, &salt_bytes);
        let commitment = client.commitment_of(&task, &bidder, &price, &terms, &salt);
        let reputation = 50 + (i % 50);
        client.submit_bid(&task, &bidder, &commitment, &500_000, &reputation);
        bidders.push((bidder, price, salt));
    }

    // Advance to reveal phase
    env.ledger().with_mut(|ledger| ledger.timestamp += 60);
    
    // Reveal all bids
    for (bidder, price, salt) in bidders.iter() {
        let terms = String::from_str(&env, "terms");
        client.reveal_bid(&task, bidder, price, &terms, salt);
    }
    
    // Advance past reveal deadline
    env.ledger().with_mut(|ledger| ledger.timestamp += 600);
    
    // Measure gas for finalization
    env.cost_estimate().budget().reset_tracker();
    client.reveal_bids(&Address::generate(&env), &task);
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&Symbol::new(&env, "finalize"), &50);
    
    std::println!("finalize_auction (50 bidders): estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);
}
