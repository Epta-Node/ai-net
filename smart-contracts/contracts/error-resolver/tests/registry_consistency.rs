//! Cross-contract consistency: every `#[contracterror]` code defined by
//! `error-registry` must resolve in `error-resolver`, and every
//! `error-registry` entry in the resolver database must correspond to a code
//! the registry still defines. Adding an unmatched code on either side fails.

use error_registry::Error as RegistryError;
use error_resolver::{ErrorResolver, UNKNOWN_CONTRACT_ERROR_FALLBACK};
use std::collections::BTreeMap;

const REGISTRY: &str = "error-registry";

/// Upper bound on codes probed. Comfortably above the registry's enum size;
/// the guard test below fails if the registry ever approaches it.
const PROBE_LIMIT: u32 = 256;

/// Every code the registry's error enum defines, mapped to its variant name.
fn registry_codes() -> BTreeMap<u32, String> {
    (0..=PROBE_LIMIT)
        .filter_map(|code| {
            RegistryError::try_from(soroban_sdk::Error::from_contract_error(code))
                .ok()
                .map(|variant| (code, format!("{variant:?}")))
        })
        .collect()
}

#[test]
fn registry_enum_is_probed_completely() {
    let codes = registry_codes();
    assert!(!codes.is_empty(), "no registry codes discovered");
    let max = *codes.keys().max().unwrap();
    assert!(
        max < PROBE_LIMIT / 2,
        "raise PROBE_LIMIT: max code is {max}"
    );
    // Probe round-trips: the enum discriminant equals the probed code.
    for code in codes.keys() {
        let variant =
            RegistryError::try_from(soroban_sdk::Error::from_contract_error(*code)).unwrap();
        assert_eq!(variant as u32, *code);
    }
}

#[test]
fn every_registry_code_resolves_in_resolver() {
    let resolver = ErrorResolver::new();
    for (code, name) in registry_codes() {
        let entry = resolver
            .lookup_contract_error(REGISTRY, code)
            .unwrap_or_else(|| panic!("registry code {code} ({name}) has no resolver entry"));
        assert_eq!(entry.name, name, "name drift for registry code {code}");
        assert!(!entry.fix_suggestion.is_empty());
        assert_ne!(
            resolver.resolve_contract_error(REGISTRY, code),
            UNKNOWN_CONTRACT_ERROR_FALLBACK
        );
    }
}

#[test]
fn resolver_has_no_orphan_registry_entries() {
    let resolver = ErrorResolver::new();
    let defined = registry_codes();
    for code in resolver.contract_error_codes(REGISTRY) {
        assert!(
            defined.contains_key(&code),
            "resolver entry for registry code {code} has no matching variant"
        );
    }
}

#[test]
fn registry_and_resolver_code_sets_are_identical() {
    let resolver = ErrorResolver::new();
    let defined: Vec<u32> = registry_codes().into_keys().collect();
    assert_eq!(resolver.contract_error_codes(REGISTRY), defined);
}

#[test]
fn registry_errors_raised_on_chain_resolve() {
    use error_registry::{ErrorRegistryContract, ErrorRegistryContractClient};
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Symbol};

    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(ErrorRegistryContract, ());
    let client = ErrorRegistryContractClient::new(&env, &id);
    let resolver = ErrorResolver::new();

    // NotInitialized from an admin entrypoint before initialize.
    let err = client.try_pause().unwrap_err().unwrap();
    assert_eq!(err, RegistryError::NotInitialized);
    assert!(resolver
        .resolve_contract_error(REGISTRY, err as u32)
        .contains("initialize"));

    client.initialize(&Address::generate(&env));

    // InvalidTtl from submit_error.
    let err = client
        .try_submit_error(
            &BytesN::from_array(&env, &[1; 32]),
            &42,
            &Symbol::new(&env, "msg"),
            &Symbol::new(&env, "agent"),
            &0,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, RegistryError::InvalidTtl);
    assert_eq!(
        resolver
            .lookup_contract_error(REGISTRY, err as u32)
            .unwrap()
            .name,
        "InvalidTtl"
    );
}
