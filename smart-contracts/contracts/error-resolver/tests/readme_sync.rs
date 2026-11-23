//! Keeps `README.md` in sync with `src/errors.toml`: every host-error mapping
//! and every contract error code in the resolver database must have a row in
//! the README's error code reference.

use error_resolver::ErrorResolver;

const README: &str = include_str!("../README.md");

fn table_rows() -> Vec<Vec<String>> {
    README
        .lines()
        .filter(|line| line.starts_with('|'))
        .map(|line| {
            line.trim_matches('|')
                .split('|')
                .map(|cell| cell.trim().trim_matches('`').to_string())
                .collect()
        })
        .collect()
}

#[test]
fn every_host_error_mapping_is_documented() {
    let rows = table_rows();
    let resolver = ErrorResolver::new();
    assert!(!resolver.all_mappings().is_empty());
    for (category, code) in resolver.all_mappings().keys() {
        let category = category.to_string();
        assert!(
            rows.iter().any(|row| row.len() == 4
                && row[0] == category
                && row[1] == *code
                && !row[2].is_empty()
                && !row[3].is_empty()),
            "README is missing a host-error row for ({category}, {code})"
        );
    }
}

#[test]
fn every_contract_error_is_documented() {
    let rows = table_rows();
    let resolver = ErrorResolver::new();
    let contract = "error-registry";
    let codes = resolver.contract_error_codes(contract);
    assert!(!codes.is_empty());
    assert!(
        README.contains(&format!("#### `{contract}`")),
        "README is missing a section for {contract}"
    );
    for code in codes {
        let entry = resolver.lookup_contract_error(contract, code).unwrap();
        assert!(
            rows.iter().any(|row| row.len() == 4
                && row[0] == code.to_string()
                && row[1] == entry.name
                && !row[2].is_empty()
                && !row[3].is_empty()),
            "README is missing a row for {contract} code {code} ({})",
            entry.name
        );
    }
}
