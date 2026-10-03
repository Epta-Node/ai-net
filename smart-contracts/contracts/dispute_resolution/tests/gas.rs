use dispute_resolution::{DisputeResolutionContract, DisputeResolutionContractClient};
use soroban_sdk::{testutils::Address as _, Address, Env, String, Symbol};

#[test]
fn dispute_estimate_is_within_twenty_percent_of_file_dispute_cost() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(DisputeResolutionContract, ());
    let client = DisputeResolutionContractClient::new(&env, &id);
    client.initialize(&Address::generate(&env));

    env.cost_estimate().budget().reset_tracker();
    client.file_dispute(
        &Symbol::new(&env, "task"),
        &Address::generate(&env),
        &Address::generate(&env),
        &String::from_str(&env, "reason"),
    );
    let actual = env.cost_estimate().budget().cpu_instruction_cost();
    let estimate = client.estimate_gas(&Symbol::new(&env, "dispute"), &5);

    assert!(actual > 0);
    assert!(
        estimate.saturating_mul(100) >= actual.saturating_mul(80),
        "estimate {estimate} is below actual {actual}"
    );
    assert!(
        estimate.saturating_mul(100) <= actual.saturating_mul(120),
        "estimate {estimate} is above actual {actual}"
    );
}
