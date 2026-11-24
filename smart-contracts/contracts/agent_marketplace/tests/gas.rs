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
