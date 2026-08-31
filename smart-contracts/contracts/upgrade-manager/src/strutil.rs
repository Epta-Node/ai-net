//! # `no_std` helpers for inspecting [`soroban_sdk::String`]
//!
//! Host strings cannot be turned into a Rust `str` inside a `no_std` contract:
//! `ToString` lives behind `alloc` and is compiled out entirely for the
//! `wasm32v1-none` target. These helpers copy the host string into a small
//! stack buffer instead, so the same code path runs natively and on-chain.
//!
//! Comparisons against longer literals than [`MAX_TAG_LEN`] simply return
//! `false`; every tag matched by this contract is a short ASCII identifier.

use soroban_sdk::String;

/// Upper bound on the literals compared by [`str_eq`] and [`starts_with`].
///
/// Every validation-check, transformation and version tag used by the upgrade
/// manager is a short ASCII identifier, so a 64-byte stack buffer is ample and
/// keeps the contract's stack footprint bounded.
pub const MAX_TAG_LEN: usize = 64;

/// Returns `true` when `value` holds exactly the bytes of `literal`.
///
/// Returns `false` for anything longer than [`MAX_TAG_LEN`] rather than
/// panicking, so an oversized caller-supplied tag is treated as "no match".
pub fn str_eq(value: &String, literal: &str) -> bool {
    let len = value.len() as usize;
    if len != literal.len() || len > MAX_TAG_LEN {
        return false;
    }
    let mut buf = [0u8; MAX_TAG_LEN];
    value.copy_into_slice(&mut buf[..len]);
    buf[..len] == *literal.as_bytes()
}

/// Returns `true` when `value` begins with `prefix`.
///
/// Used for major-version checks such as `"1."`. Like [`str_eq`], a value
/// longer than [`MAX_TAG_LEN`] returns `false` instead of panicking.
pub fn starts_with(value: &String, prefix: &str) -> bool {
    let len = value.len() as usize;
    let plen = prefix.len();
    if plen > len || len > MAX_TAG_LEN {
        return false;
    }
    let mut buf = [0u8; MAX_TAG_LEN];
    value.copy_into_slice(&mut buf[..len]);
    buf[..plen] == *prefix.as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn str_eq_matches_only_exact_bytes() {
        let env = Env::default();
        let value = String::from_str(&env, "rebuild_indexes");
        assert!(str_eq(&value, "rebuild_indexes"));
        assert!(!str_eq(&value, "rebuild_index"));
        assert!(!str_eq(&value, "rebuild_indexes "));
        assert!(!str_eq(&value, ""));
    }

    #[test]
    fn str_eq_handles_empty_string() {
        let env = Env::default();
        let empty = String::from_str(&env, "");
        assert!(str_eq(&empty, ""));
        assert!(!str_eq(&empty, "x"));
    }

    #[test]
    fn oversized_values_do_not_panic() {
        let env = Env::default();
        // 65 bytes — one past MAX_TAG_LEN.
        let long = String::from_str(
            &env,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        assert_eq!(long.len() as usize, MAX_TAG_LEN + 1);
        assert!(!str_eq(&long, "a"));
        assert!(!starts_with(&long, "a"));
    }

    #[test]
    fn starts_with_matches_major_version_prefixes() {
        let env = Env::default();
        let v1 = String::from_str(&env, "1.4.2");
        let v2 = String::from_str(&env, "2.0.0");
        assert!(starts_with(&v1, "1."));
        assert!(!starts_with(&v1, "2."));
        assert!(starts_with(&v2, "2."));
        // A prefix longer than the value never matches.
        assert!(!starts_with(&v1, "1.4.2.9"));
        // Every string starts with the empty prefix.
        assert!(starts_with(&v1, ""));
    }
}
