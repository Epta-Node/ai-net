use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

/// Categories of Tier 1 Soroban host errors
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorCategory {
    Budget,
    Storage,
    Auth,
    Contract,
}

impl std::fmt::Display for ErrorCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            ErrorCategory::Budget => "budget",
            ErrorCategory::Storage => "storage",
            ErrorCategory::Auth => "auth",
            ErrorCategory::Contract => "contract",
        };
        write!(f, "{}", s)
    }
}

/// Standard Tier 1 Soroban host error codes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ErrorCode {
    ExceededLimit,
    MissingValue,
    ExistingValue,
    InvalidAction,
    InvalidInput,
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            ErrorCode::ExceededLimit => "ExceededLimit",
            ErrorCode::MissingValue => "MissingValue",
            ErrorCode::ExistingValue => "ExistingValue",
            ErrorCode::InvalidAction => "InvalidAction",
            ErrorCode::InvalidInput => "InvalidInput",
        };
        write!(f, "{}", s)
    }
}

/// Entry mapping an error to its fix suggestion
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorMappingEntry {
    pub category: ErrorCategory,
    pub error_code: String,
    pub fix_suggestion: String,
}

/// Entry mapping a contract-specific `#[contracterror]` code to a fix suggestion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractErrorEntry {
    /// Crate name of the contract defining the code (e.g. `error-registry`).
    pub contract: String,
    /// Numeric `#[contracterror]` discriminant.
    pub code: u32,
    /// Variant name, used to detect renames drifting from the contract enum.
    pub name: String,
    pub fix_suggestion: String,
}

/// Suggestion returned by [`ErrorResolver::resolve_contract_error`] when the
/// (contract, code) pair has no entry in the database.
pub const UNKNOWN_CONTRACT_ERROR_FALLBACK: &str = "Unknown contract error code. Inspect the contract's #[contracterror] enum for this code and add a matching [[contract_errors]] entry to errors.toml.";

#[derive(Debug, Deserialize)]
struct TomlData {
    errors: Vec<ErrorMappingEntry>,
    #[serde(default)]
    contract_errors: Vec<ContractErrorEntry>,
}

/// Core resolver that maps (Category, Code) to actionable recommendations.
pub struct ErrorResolver {
    mappings: HashMap<(ErrorCategory, String), String>,
    contract_mappings: HashMap<(String, u32), ContractErrorEntry>,
}

impl Default for ErrorResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl ErrorResolver {
    /// Create a new resolver by loading the embedded TOML database.
    pub fn new() -> Self {
        let toml_content = include_str!("errors.toml");
        Self::from_toml(toml_content).unwrap_or_else(|_| Self::new_fallback())
    }

    /// Load the resolver from a custom TOML string content.
    pub fn from_toml(content: &str) -> Result<Self, toml::de::Error> {
        let data: TomlData = toml::from_str(content)?;
        let mut mappings = HashMap::new();
        for entry in data.errors {
            mappings.insert((entry.category, entry.error_code), entry.fix_suggestion);
        }
        let mut contract_mappings = HashMap::new();
        for entry in data.contract_errors {
            contract_mappings.insert((entry.contract.clone(), entry.code), entry);
        }
        Ok(Self {
            mappings,
            contract_mappings,
        })
    }

    /// Static fallback map if TOML parsing fails.
    fn new_fallback() -> Self {
        let mut mappings = HashMap::new();
        let fallback_data = [
            (
                ErrorCategory::Budget,
                "ExceededLimit",
                "The transaction has exceeded the allocated CPU or memory instructions budget. Optimize loops, avoid excessive memory allocation, or configure a higher resource limit fee when submitting the transaction.",
            ),
            (
                ErrorCategory::Storage,
                "MissingValue",
                "The requested ledger entry (e.g., persistent data, contract instance, or Wasm bytecode) does not exist or has been archived. Verify that the entry was created, or submit a RestoreFootprintOp transaction to restore the archived entry.",
            ),
            (
                ErrorCategory::Storage,
                "ExceededLimit",
                "The transaction attempted to access a ledger entry that was not declared in the read/write footprint, or exceeded size limits. Run a transaction simulation (simulateTransaction) first to obtain the correct footprint and declare all accessed entries.",
            ),
            (
                ErrorCategory::Storage,
                "ExistingValue",
                "The ledger entry or storage key already exists and cannot be overwritten as a new entry. Check if you should perform an update/put operation instead of creating a new entry, or verify key initialization logic.",
            ),
            (
                ErrorCategory::Auth,
                "InvalidAction",
                "The authorization check failed. Verify that all required addresses (e.g. signer keypairs) have signed the authorization payloads, check that arguments are deterministic, and ensure nonces are not expired or reused.",
            ),
            (
                ErrorCategory::Contract,
                "InvalidAction",
                "The smart contract encountered an invalid operation in its current state. Check contract state constraints, invariant checks, and ensure conditions for this state transition are met.",
            ),
            (
                ErrorCategory::Contract,
                "InvalidInput",
                "The inputs passed to the contract function are invalid or out of bounds. Verify the arguments passed to the function call match the expected types and validate constraints.",
            ),
        ];

        for (cat, code, suggestion) in fallback_data {
            mappings.insert((cat, code.to_string()), suggestion.to_string());
        }

        Self {
            mappings,
            contract_mappings: HashMap::new(),
        }
    }

    /// Lookup a suggestion using category and error code enums.
    pub fn lookup(&self, category: ErrorCategory, code: ErrorCode) -> Option<&str> {
        self.lookup_str(category, &code.to_string())
    }

    /// Lookup a suggestion using category enum and string representation of the error code.
    pub fn lookup_str(&self, category: ErrorCategory, code: &str) -> Option<&str> {
        self.mappings
            .get(&(category, code.to_string()))
            .map(|s| s.as_str())
    }

    /// Get a reference to the internal mappings map.
    pub fn all_mappings(&self) -> &HashMap<(ErrorCategory, String), String> {
        &self.mappings
    }

    /// Lookup the entry for a contract-specific error code.
    pub fn lookup_contract_error(&self, contract: &str, code: u32) -> Option<&ContractErrorEntry> {
        self.contract_mappings.get(&(contract.to_string(), code))
    }

    /// Resolve a contract-specific error code to a fix suggestion, returning
    /// [`UNKNOWN_CONTRACT_ERROR_FALLBACK`] when no entry exists.
    pub fn resolve_contract_error(&self, contract: &str, code: u32) -> &str {
        self.lookup_contract_error(contract, code)
            .map(|e| e.fix_suggestion.as_str())
            .unwrap_or(UNKNOWN_CONTRACT_ERROR_FALLBACK)
    }

    /// All codes known for `contract`, sorted ascending.
    pub fn contract_error_codes(&self, contract: &str) -> Vec<u32> {
        let mut codes: Vec<u32> = self
            .contract_mappings
            .keys()
            .filter(|(c, _)| c == contract)
            .map(|(_, code)| *code)
            .collect();
        codes.sort_unstable();
        codes
    }
}

/// Global static resolver instance initialized once on first access.
pub fn global_resolver() -> &'static ErrorResolver {
    static RESOLVER: OnceLock<ErrorResolver> = OnceLock::new();
    RESOLVER.get_or_init(ErrorResolver::new)
}

/// Lookup a suggestion globally using enums.
pub fn lookup_suggestion(category: ErrorCategory, code: ErrorCode) -> Option<&'static str> {
    global_resolver().lookup(category, code)
}

/// Lookup a suggestion globally using category enum and string code.
pub fn lookup_suggestion_str(category: ErrorCategory, code: &str) -> Option<&'static str> {
    global_resolver().lookup_str(category, code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedded_toml_load() {
        let resolver = ErrorResolver::new();
        assert!(!resolver.all_mappings().is_empty());
    }

    #[test]
    fn test_lookup_budget_exceeded_limit() {
        let suggestion = lookup_suggestion(ErrorCategory::Budget, ErrorCode::ExceededLimit);
        assert!(suggestion.is_some());
        let msg = suggestion.unwrap();
        assert!(msg.contains("instructions budget"));
        assert!(msg.contains("Optimize loops"));
    }

    #[test]
    fn test_lookup_storage_missing_value() {
        let suggestion = lookup_suggestion(ErrorCategory::Storage, ErrorCode::MissingValue);
        assert!(suggestion.is_some());
        let msg = suggestion.unwrap();
        assert!(msg.contains("ledger entry"));
        assert!(msg.contains("RestoreFootprintOp"));
    }

    #[test]
    fn test_lookup_auth_invalid_action() {
        let suggestion = lookup_suggestion(ErrorCategory::Auth, ErrorCode::InvalidAction);
        assert!(suggestion.is_some());
        let msg = suggestion.unwrap();
        assert!(msg.contains("authorization check failed"));
    }

    #[test]
    fn test_lookup_contract_invalid_input() {
        let suggestion = lookup_suggestion(ErrorCategory::Contract, ErrorCode::InvalidInput);
        assert!(suggestion.is_some());
        let msg = suggestion.unwrap();
        assert!(msg.contains("inputs passed to the contract function are invalid"));
    }

    #[test]
    fn test_lookup_nonexistent() {
        let suggestion = lookup_suggestion_str(ErrorCategory::Budget, "NonExistentErrorCode");
        assert!(suggestion.is_none());
    }

    #[test]
    fn test_display_traits() {
        assert_eq!(format!("{}", ErrorCategory::Budget), "budget");
        assert_eq!(format!("{}", ErrorCode::ExceededLimit), "ExceededLimit");
    }
}
