//! Gas estimates for registry operations, in CPU instructions (CU).
use soroban_sdk::{symbol_short, Env, String, Symbol};

pub const GAS_TX_OVERHEAD: u64 = 40_000;
pub const GAS_REGISTER_AGENT: u64 = 170_000;
pub const GAS_REGISTER_AGENT_MARGINAL: u64 = 130_000;
pub const GAS_RESOLVE_ERROR: u64 = 42_000;
pub const GAS_RESOLVE_ERROR_MARGINAL: u64 = 22_000;
pub const GAS_SLASH_BOND: u64 = 52_000;
pub const GAS_DEREGISTER_WITH_BOND: u64 = 68_000;
pub const GAS_CLEANUP_ERROR: u64 = 16_000;
pub const GAS_CLEANUP_ERROR_MARGINAL: u64 = 8_000;

pub fn estimate(env: &Env, operation: String, count: u32, cfg: &crate::GasConfig) -> u64 {
    if count == 0 {
        return 0;
    }
    let names = [
        (
            "register_agent",
            cfg.register_agent,
            cfg.register_agent_marginal,
        ),
        (
            "register_agents",
            cfg.register_agent,
            cfg.register_agent_marginal,
        ),
        (
            "resolve_error",
            cfg.resolve_error,
            cfg.resolve_error_marginal,
        ),
        (
            "resolve_errors",
            cfg.resolve_error,
            cfg.resolve_error_marginal,
        ),
        (
            "cleanup_expired_errors",
            cfg.cleanup_error,
            cfg.cleanup_error_marginal,
        ),
    ];
    for (name, first, marginal) in names {
        if operation == String::from_str(env, name) {
            return first.saturating_add(marginal.saturating_mul((count - 1) as u64));
        }
    }
    if operation == String::from_str(env, "slash_bond") {
        return cfg.slash_bond.saturating_mul(count as u64);
    }
    if operation == String::from_str(env, "deregister_with_bond") {
        return cfg.deregister_with_bond.saturating_mul(count as u64);
    }
    0
}

pub fn estimate_shared(operation: Symbol, count: u32) -> u64 {
    if count == 0 {
        return 0;
    }
    let cfg = crate::GasConfig::default_config();
    let (first, marginal) = if operation == symbol_short!("register") {
        (cfg.register_agent, cfg.register_agent_marginal)
    } else if operation == symbol_short!("resolve") {
        (cfg.resolve_error, cfg.resolve_error_marginal)
    } else if operation == symbol_short!("cleanup") {
        (cfg.cleanup_error, cfg.cleanup_error_marginal)
    } else if operation == symbol_short!("slash") {
        return cfg.slash_bond.saturating_mul(count as u64);
    } else if operation == symbol_short!("dereg") {
        return cfg.deregister_with_bond.saturating_mul(count as u64);
    } else {
        return 0;
    };
    first.saturating_add(marginal.saturating_mul((count - 1) as u64))
}
