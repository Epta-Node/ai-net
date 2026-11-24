//! Off-chain resolver behaviour: resolve, fallback and unknown-code handling.

use error_resolver::{
    lookup_suggestion, lookup_suggestion_str, ErrorCategory, ErrorCode, ErrorResolver,
    UNKNOWN_CONTRACT_ERROR_FALLBACK,
};

const ALL_CATEGORIES: [ErrorCategory; 4] = [
    ErrorCategory::Budget,
    ErrorCategory::Storage,
    ErrorCategory::Auth,
    ErrorCategory::Contract,
];

const ALL_CODES: [ErrorCode; 5] = [
    ErrorCode::ExceededLimit,
    ErrorCode::MissingValue,
    ErrorCode::ExistingValue,
    ErrorCode::InvalidAction,
    ErrorCode::InvalidInput,
];

#[test]
fn every_embedded_host_mapping_resolves_via_enum_and_str() {
    let resolver = ErrorResolver::new();
    assert_eq!(resolver.all_mappings().len(), 7);
    for ((category, code), suggestion) in resolver.all_mappings() {
        assert!(!suggestion.is_empty());
        assert_eq!(
            resolver.lookup_str(*category, code),
            Some(suggestion.as_str())
        );
        assert_eq!(
            lookup_suggestion_str(*category, code),
            Some(suggestion.as_str())
        );
    }
}

#[test]
fn enum_and_string_lookups_agree_for_every_pair() {
    let resolver = ErrorResolver::new();
    for category in ALL_CATEGORIES {
        for code in ALL_CODES {
            assert_eq!(
                resolver.lookup(category, code),
                resolver.lookup_str(category, &code.to_string()),
                "{category}/{code}"
            );
            assert_eq!(
                lookup_suggestion(category, code),
                resolver.lookup(category, code)
            );
        }
    }
}

#[test]
fn unmapped_host_pair_returns_none() {
    // Budget only defines ExceededLimit.
    assert!(lookup_suggestion(ErrorCategory::Budget, ErrorCode::MissingValue).is_none());
    assert!(lookup_suggestion_str(ErrorCategory::Auth, "NoSuchCode").is_none());
    // Code strings are case-sensitive.
    assert!(lookup_suggestion_str(ErrorCategory::Budget, "exceededlimit").is_none());
}

#[test]
fn custom_toml_replaces_embedded_database() {
    let resolver = ErrorResolver::from_toml(
        r#"
        [[errors]]
        category = "auth"
        error_code = "InvalidAction"
        fix_suggestion = "custom"

        [[contract_errors]]
        contract = "demo"
        code = 7
        name = "Boom"
        fix_suggestion = "defuse"
        "#,
    )
    .expect("valid toml");
    assert_eq!(resolver.all_mappings().len(), 1);
    assert_eq!(
        resolver.lookup(ErrorCategory::Auth, ErrorCode::InvalidAction),
        Some("custom")
    );
    assert!(resolver
        .lookup(ErrorCategory::Budget, ErrorCode::ExceededLimit)
        .is_none());
    assert_eq!(resolver.resolve_contract_error("demo", 7), "defuse");
    assert_eq!(
        resolver.lookup_contract_error("demo", 7).unwrap().name,
        "Boom"
    );
}

#[test]
fn contract_errors_section_is_optional() {
    let resolver = ErrorResolver::from_toml(
        r#"
        [[errors]]
        category = "budget"
        error_code = "ExceededLimit"
        fix_suggestion = "x"
        "#,
    )
    .expect("valid toml");
    assert!(resolver.contract_error_codes("error-registry").is_empty());
}

#[test]
fn malformed_toml_is_rejected() {
    assert!(ErrorResolver::from_toml("errors = 5").is_err());
    assert!(ErrorResolver::from_toml(
        r#"
        [[errors]]
        category = "not-a-category"
        error_code = "X"
        fix_suggestion = "y"
        "#
    )
    .is_err());
}

#[test]
fn unknown_contract_code_yields_documented_fallback() {
    let resolver = ErrorResolver::new();
    assert!(resolver
        .lookup_contract_error("error-registry", 9_999)
        .is_none());
    assert_eq!(
        resolver.resolve_contract_error("error-registry", 9_999),
        UNKNOWN_CONTRACT_ERROR_FALLBACK
    );
    assert_eq!(
        resolver.resolve_contract_error("no-such-contract", 1),
        UNKNOWN_CONTRACT_ERROR_FALLBACK
    );
    assert_eq!(
        resolver.resolve_contract_error("error-registry", 0),
        UNKNOWN_CONTRACT_ERROR_FALLBACK
    );
}

#[test]
fn known_contract_code_does_not_use_fallback() {
    let resolver = ErrorResolver::new();
    let resolved = resolver.resolve_contract_error("error-registry", 2);
    assert_ne!(resolved, UNKNOWN_CONTRACT_ERROR_FALLBACK);
    assert!(resolved.contains("ttl_seconds"));
}
