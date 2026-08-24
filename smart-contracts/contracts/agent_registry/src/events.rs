//! # Event Types for Agent Registry
//!
//! This module defines the typed structs that are emitted as Soroban contract
//! events. Each struct corresponds to one event topic and is published via
//! `env.events().publish(topic, data)`.
//!
//! ## Topic convention
//!
//! All events share a two-symbol topic prefix:
//!
//! ```text
//! ("registry", "<action>")
//! ```
//!
//! This lets off-chain indexers filter events by contract + topic[1] without
//! needing to know every possible action in advance.
//!
//! ## Event catalogue
//!
//! | Function            | topic[1]           | Data fields                                              |
//! |---------------------|--------------------|----------------------------------------------------------|
//! | `initialize`        | `initialized`      | `admin`                                                  |
//! | `set_admin`         | `admin_changed`    | `old_admin`, `new_admin`                                 |
//! | `register_agent`    | `agent_registered` | `agent_id`, `owner`, `capability`, `price_stroops`       |
//! | `register_agents`   | `agent_registered` | same — one event per successfully committed agent        |
//! | `deregister_agent`  | `agent_deregistered` | `agent_id`, `owner`, `capability`                      |
//! | `report_error`      | `error_reported`   | `error_id`, `reporter`                                   |
//! | `resolve_errors`    | `error_resolved`   | `error_id`, `resolution` — one event per resolved error  |
//! | `pause`             | `paused`           | `()`                                                     |
//! | `unpause`           | `unpaused`         | `()`                                                     |
//! | `freeze_agent`      | `freeze`           | `agent_id`                                               |
//! | `unfreeze_agent`    | `unfreeze`         | `agent_id`                                               |
//! | `update_pricing`    | `price_upd`        | `(agent_id, new_price)`                                  |

use soroban_sdk::{contracttype, Address, BytesN, Symbol};

// ─── Legacy structs (kept for ABI compatibility) ──────────────────────────────

/// Emitted by legacy indexers; superseded by the inline tuple events.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRegistered {
    pub agent_id: Symbol,
    pub agent_type: Symbol,
    pub owner: Address,
    pub timestamp: u64,
}

/// Emitted by legacy status-change paths; superseded by freeze/unfreeze events.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentStatusChanged {
    pub agent_id: Symbol,
    pub old_status: Symbol,
    pub new_status: Symbol,
}

/// Emitted by legacy deregistration paths; superseded by `AgentDeregisteredEvent`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRemoved {
    pub agent_id: Symbol,
}

// ─── New typed event data structs ────────────────────────────────────────────

/// Data payload for `(registry, initialized)`.
///
/// Published once when the contract is first initialised with an admin address.
/// Indexers should record this to establish the genesis admin and contract
/// activation time.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RegistryInitializedEvent {
    /// The address that was set as the initial admin.
    pub admin: Address,
}

/// Data payload for `(registry, admin_changed)`.
///
/// Published every time `set_admin` succeeds. Indexers can maintain a full
/// audit trail of admin rotations for compliance and security monitoring.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AdminChangedEvent {
    /// The admin address that was replaced.
    pub old_admin: Address,
    /// The new admin address that took effect.
    pub new_admin: Address,
}

/// Data payload for `(registry, agent_registered)`.
///
/// Published by both `register_agent` (single) and `register_agents` (batch,
/// one event per committed agent). Indexers must handle both code paths emitting
/// this same event type.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRegisteredEvent {
    /// Unique on-chain identifier of the newly registered agent.
    pub agent_id: Symbol,
    /// Wallet address of the agent owner who authorised the registration.
    pub owner: Address,
    /// Capability category advertised by this agent (e.g. `research`, `coding`).
    pub capability: Symbol,
    /// Asking price in stroops (1 XLM = 10,000,000 stroops).
    pub price_stroops: i128,
}

/// Data payload for `(registry, agent_deregistered)`.
///
/// Published when an owner removes their agent from the registry. The owner
/// and capability are included so indexers can update capability indexes and
/// ownership maps without a separate read.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentDeregisteredEvent {
    /// The agent that was removed.
    pub agent_id: Symbol,
    /// Owner who authorised the deregistration.
    pub owner: Address,
    /// Capability the agent was advertising (helps indexers clean up indexes).
    pub capability: Symbol,
}

/// Data payload for `(registry, error_reported)`.
///
/// Published when a new operational error is submitted via `report_error`.
/// Monitoring systems can subscribe to this event to trigger alerting pipelines
/// without polling the contract state.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ErrorReportedEvent {
    /// 32-byte unique identifier for this error record.
    pub error_id: BytesN<32>,
    /// Address that filed the report (must have provided auth).
    pub reporter: Address,
}

/// Data payload for `(registry, error_resolved)`.
///
/// Published once per resolved error inside `resolve_errors`. Batch resolutions
/// emit multiple events — one per error — so indexers can track each resolution
/// independently without inspecting contract storage.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ErrorResolvedEvent {
    /// The error record that was closed.
    pub error_id: BytesN<32>,
    /// How the error was closed: `Fixed`, `Ignored`, or `Escalated`.
    pub resolution_code: u32,
}
