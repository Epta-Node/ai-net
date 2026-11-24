//! # `no_std` helpers for inspecting [`soroban_sdk::String`]
//!
//! Host strings cannot be turned into a Rust `str` inside a `no_std` contract:
//! `ToString` lives behind `alloc` and is compiled out entirely for the
//! `wasm32v1-none` target. These helpers copy the host string into a small
//! stack buffer instead, so the same code path runs natively and on-chain.
//!
//! Comparisons against longer literals than [`MAX_TAG_LEN`] simply return
//! `false`; every tag matched by this contract is a short ASCII identifier.

use core::cmp::Ordering;
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

/// Returns `true` if `value` represents a valid semantic version string (e.g. "1.0.0", "0.9.0", "99.0.0").
pub fn is_valid_version(value: &String) -> bool {
    let len = value.len() as usize;
    if len == 0 || len > MAX_TAG_LEN {
        return false;
    }
    let mut buf = [0u8; MAX_TAG_LEN];
    value.copy_into_slice(&mut buf[..len]);
    let s = &buf[..len];

    let mut dot_count = 0;
    let mut part_len = 0;
    for &b in s {
        if b == b'.' {
            if part_len == 0 {
                return false;
            }
            dot_count += 1;
            part_len = 0;
        } else if b.is_ascii_digit() {
            part_len += 1;
        } else if b == b'-' || b == b'+' {
            break;
        } else {
            return false;
        }
    }
    dot_count >= 2 && part_len > 0
}

/// Maximum number of numeric components accepted in a version tag.
pub const MAX_VERSION_COMPONENTS: usize = 8;

/// A version tag parsed out of a byte slice without allocating.
struct ParsedVersion<'a> {
    parts: [u32; MAX_VERSION_COMPONENTS],
    count: usize,
    /// Pre-release suffix after `-` (without the `-`), empty for releases.
    pre: &'a [u8],
}

fn parse_numeric(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() {
        return None;
    }
    let mut value: u32 = 0;
    for &b in bytes {
        if !b.is_ascii_digit() {
            return None;
        }
        value = value.checked_mul(10)?.checked_add((b - b'0') as u32)?;
    }
    Some(value)
}

fn parse_version(bytes: &[u8]) -> Option<ParsedVersion<'_>> {
    // Build metadata (`+...`) never participates in precedence.
    let (without_build, build) = match bytes.iter().position(|&b| b == b'+') {
        Some(i) => (&bytes[..i], Some(&bytes[i + 1..])),
        None => (bytes, None),
    };
    if let Some(build) = build {
        if build.is_empty()
            || !build
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || *b == b'.' || *b == b'-')
        {
            return None;
        }
    }
    let (core, pre) = match without_build.iter().position(|&b| b == b'-') {
        Some(i) => (&without_build[..i], &without_build[i + 1..]),
        None => (without_build, &without_build[without_build.len()..]),
    };
    if without_build.len() != core.len() {
        // A `-` was present: the pre-release must be non-empty dot-separated
        // alphanumeric identifiers.
        if pre.is_empty() {
            return None;
        }
        for ident in pre.split(|&b| b == b'.') {
            if ident.is_empty()
                || !ident
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
            {
                return None;
            }
        }
    }

    let mut parts = [0u32; MAX_VERSION_COMPONENTS];
    let mut count = 0;
    for component in core.split(|&b| b == b'.') {
        if count == MAX_VERSION_COMPONENTS {
            return None;
        }
        parts[count] = parse_numeric(component)?;
        count += 1;
    }
    Some(ParsedVersion { parts, count, pre })
}

fn compare_pre_release(a: &[u8], b: &[u8]) -> Ordering {
    // A release (no pre-release) has higher precedence than any pre-release.
    match (a.is_empty(), b.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        (false, false) => {}
    }
    let mut left = a.split(|&c| c == b'.');
    let mut right = b.split(|&c| c == b'.');
    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let ord = match (parse_numeric(x), parse_numeric(y)) {
                    (Some(nx), Some(ny)) => nx.cmp(&ny),
                    // Numeric identifiers sort below alphanumeric ones.
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => x.cmp(y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

/// Semver-style precedence of two raw version tags.
///
/// * Numeric components are compared as integers, component-wise; missing
///   trailing components count as `0` (`1.0` == `1.0.0`).
/// * A pre-release (`1.0.0-rc.1`) sorts **below** its release (`1.0.0`).
///   Pre-release identifiers are compared per SemVer 2.0 §11: numeric
///   identifiers numerically, alphanumeric ones byte-wise, numeric < alpha,
///   and a shorter identifier list sorts first when all shared ones are equal.
/// * Build metadata (`+build.5`) is ignored.
///
/// Returns `None` when either tag is malformed (empty/non-numeric component,
/// overflow, more than [`MAX_VERSION_COMPONENTS`] components, bad suffix).
pub fn compare_version_bytes(a: &[u8], b: &[u8]) -> Option<Ordering> {
    let va = parse_version(a)?;
    let vb = parse_version(b)?;
    let n = if va.count > vb.count {
        va.count
    } else {
        vb.count
    };
    for i in 0..n {
        let ord = va.parts[i].cmp(&vb.parts[i]);
        if ord != Ordering::Equal {
            return Some(ord);
        }
    }
    Some(compare_pre_release(va.pre, vb.pre))
}

/// [`compare_version_bytes`] over host strings. Tags longer than
/// [`MAX_TAG_LEN`] are treated as malformed.
pub fn compare_versions(a: &String, b: &String) -> Option<Ordering> {
    let (la, lb) = (a.len() as usize, b.len() as usize);
    if la > MAX_TAG_LEN || lb > MAX_TAG_LEN {
        return None;
    }
    let mut ba = [0u8; MAX_TAG_LEN];
    let mut bb = [0u8; MAX_TAG_LEN];
    a.copy_into_slice(&mut ba[..la]);
    b.copy_into_slice(&mut bb[..lb]);
    compare_version_bytes(&ba[..la], &bb[..lb])
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

    #[test]
    fn compare_versions_table() {
        use core::cmp::Ordering::*;
        let cases: &[(&str, &str, Option<Ordering>)] = &[
            // (a, b, a.cmp(b))
            ("1.10.0", "1.9.0", Some(Greater)),
            ("1.100.0", "1.99.0", Some(Greater)),
            ("10.0.0", "2.0.0", Some(Greater)),
            ("1.0.0", "1.0.0-rc.1", Some(Greater)),
            ("1.0.0", "1.0.0", Some(Equal)),
            ("1.0.1", "1.0.0", Some(Greater)),
            ("1.0", "1.0.0", Some(Equal)),
            ("1.0.0.1", "1.0.0", Some(Greater)),
            ("2", "1.9.9", Some(Greater)),
            ("1.0.0-alpha", "1.0.0-alpha.1", Some(Less)),
            ("1.0.0-alpha.1", "1.0.0-alpha.beta", Some(Less)),
            ("1.0.0-beta.2", "1.0.0-beta.11", Some(Less)),
            ("1.0.0-rc.1", "1.0.0-beta", Some(Greater)),
            ("1.0.0+build.5", "1.0.0", Some(Equal)),
            ("", "1.0.0", None),
            ("1..0", "1.0.0", None),
            ("1.x.0", "1.0.0", None),
            ("v1.0.0", "1.0.0", None),
            ("1.0.0-", "1.0.0", None),
            ("1.0.0-rc..1", "1.0.0", None),
            ("1.0.0+", "1.0.0", None),
            ("99999999999.0.0", "1.0.0", None),
            ("1.2.3.4.5.6.7.8.9", "1.0.0", None),
        ];
        let env = Env::default();
        for (a, b, expected) in cases {
            let sa = String::from_str(&env, a);
            let sb = String::from_str(&env, b);
            assert_eq!(compare_versions(&sa, &sb), *expected, "{} vs {}", a, b);
            assert_eq!(
                compare_versions(&sb, &sa),
                expected.map(Ordering::reverse),
                "{} vs {} (reversed)",
                b,
                a
            );
        }
    }
}
