use agent_marketplace::AgentMarketplaceContract;
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

#[test]
fn estimates_are_within_twenty_percent_for_listing_and_search() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentMarketplaceContract, ());
    let client = agent_marketplace::AgentMarketplaceContractClient::new(&env, &id);
    let owner = Address::generate(&env);

    env.cost_estimate().budget().reset_tracker();
    client.list_service(
        &Symbol::new(&env, "gas_svc"),
        &Symbol::new(&env, "gas_agent"),
        &owner,
        &Symbol::new(&env, "gas_cap"),
        &1_000_000,
        &200,
        &24,
    );
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&Symbol::new(&env, "listing"), &1);
    std::println!("listing estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);

    env.cost_estimate().budget().reset_tracker();
    client.book_agent(
        &Symbol::new(&env, "gas_svc"),
        &owner,
        &1_000_000,
        &Symbol::new(&env, "gas_booking"),
    );
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&Symbol::new(&env, "purchase"), &1);
    std::println!("purchase estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);

    env.cost_estimate().budget().reset_tracker();
    client.search_services(&Symbol::new(&env, "gas_cap"), &0, &0);
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&Symbol::new(&env, "search"), &1);
    std::println!("search estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);

    client.list_service(
        &Symbol::new(&env, "gas_svc2"),
        &Symbol::new(&env, "gas_agent2"),
        &owner,
        &Symbol::new(&env, "gas_cap"),
        &2_000_000,
        &250,
        &12,
    );
    env.cost_estimate().budget().reset_tracker();
    client.search_services(&Symbol::new(&env, "gas_cap"), &0, &0);
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&Symbol::new(&env, "search"), &2);
    std::println!("batch search estimate={estimate}, actual={actual}");
    assert_within_twenty_percent(estimate, actual);
}

fn assert_within_twenty_percent(estimate: u64, actual: u64) {
    assert!(actual > 0);
    assert!(
        estimate.saturating_mul(100) >= actual.saturating_mul(80),
        "estimate {estimate} below 80% of actual {actual}"
    );
    assert!(
        estimate.saturating_mul(100) <= actual.saturating_mul(120),
        "estimate {estimate} above 120% of actual {actual}"
    );
}

// ─── Gas Benchmarks for Listing Operations (issue #939) ──────────────────────

#[test]
fn benchmark_create_listing() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentMarketplaceContract, ());
    let client = agent_marketplace::AgentMarketplaceContractClient::new(&env, &id);
    let owner = Address::generate(&env);

    env.cost_estimate().budget().reset_tracker();
    client.list_service(
        &Symbol::new(&env, "bench_svc"),
        &Symbol::new(&env, "bench_agent"),
        &owner,
        &Symbol::new(&env, "bench_cap"),
        &1_000_000,
        &200,
        &24,
    );
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("create_listing: actual CPU instructions = {actual}");

    // Benchmark should be reasonable (< 200k instructions)
    assert!(actual > 0 && actual < 200_000, "create_listing gas cost: {actual}");
}

#[test]
fn benchmark_update_listing() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentMarketplaceContract, ());
    let client = agent_marketplace::AgentMarketplaceContractClient::new(&env, &id);
    let owner = Address::generate(&env);

    // Create initial listing
    client.list_service(
        &Symbol::new(&env, "upd_svc"),
        &Symbol::new(&env, "upd_agent"),
        &owner,
        &Symbol::new(&env, "upd_cap"),
        &1_000_000,
        &200,
        &24,
    );

    // Benchmark update
    env.cost_estimate().budget().reset_tracker();
    client.update_listing(
        &Symbol::new(&env, "upd_svc"),
        &2_000_000,  // New price
        &250,        // New reputation
        &12,         // New response time
    );
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("update_listing: actual CPU instructions = {actual}");

    // Update should be cheaper than creation
    assert!(actual > 0 && actual < 150_000, "update_listing gas cost: {actual}");
}

#[test]
fn benchmark_remove_listing() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentMarketplaceContract, ());
    let client = agent_marketplace::AgentMarketplaceContractClient::new(&env, &id);
    let owner = Address::generate(&env);

    // Create initial listing
    client.list_service(
        &Symbol::new(&env, "rem_svc"),
        &Symbol::new(&env, "rem_agent"),
        &owner,
        &Symbol::new(&env, "rem_cap"),
        &1_000_000,
        &200,
        &24,
    );

    // Benchmark removal
    env.cost_estimate().budget().reset_tracker();
    client.remove_listing(&Symbol::new(&env, "rem_svc"));
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("remove_listing: actual CPU instructions = {actual}");

    // Removal should be cheapest operation
    assert!(actual > 0 && actual < 100_000, "remove_listing gas cost: {actual}");
}

#[test]
fn benchmark_purchase_listing() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentMarketplaceContract, ());
    let client = agent_marketplace::AgentMarketplaceContractClient::new(&env, &id);
    let owner = Address::generate(&env);

    // Create listing
    client.list_service(
        &Symbol::new(&env, "pur_svc"),
        &Symbol::new(&env, "pur_agent"),
        &owner,
        &Symbol::new(&env, "pur_cap"),
        &1_000_000,
        &200,
        &24,
    );

    // Benchmark purchase
    env.cost_estimate().budget().reset_tracker();
    client.book_agent(
        &Symbol::new(&env, "pur_svc"),
        &owner,
        &1_000_000,
        &Symbol::new(&env, "pur_booking"),
    );
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("purchase_listing: actual CPU instructions = {actual}");

    // Purchase is more expensive due to payment processing
    assert!(actual > 0 && actual < 350_000, "purchase_listing gas cost: {actual}");
}

#[test]
fn benchmark_batch_listings() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(AgentMarketplaceContract, ());
    let client = agent_marketplace::AgentMarketplaceContractClient::new(&env, &id);
    let owner = Address::generate(&env);

    // Create multiple listings
    env.cost_estimate().budget().reset_tracker();
    for i in 0..5 {
        client.list_service(
            &Symbol::new(&env, &format!("batch_svc_{}", i)),
            &Symbol::new(&env, &format!("batch_agent_{}", i)),
            &owner,
            &Symbol::new(&env, "batch_cap"),
            &(1_000_000 + i as i128 * 100_000),
            &(200 + i as u32 * 10),
            &(24 - i),
        );
    }
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let per_listing = actual / 5;
    std::println!("batch_listings (5): total = {actual}, per listing = {per_listing}");

    // Marginal cost per listing in batch should be reasonable
    assert!(per_listing > 0 && per_listing < 200_000, "batch per-listing cost: {per_listing}");
}
