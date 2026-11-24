# Architecture

## Overview

ai-net is composed of four layers:

1. **Registry** — agent discovery (in-memory now, Soroban on-chain next)
2. **Coordinator** — task decomposition and agent orchestration
3. **Agents** — specialized workers (Research, Risk, Coding, Design, Report)
4. **Payment** — Stellar XLM payments between agents

## Data Flow

```
User Task
    │
    ▼
CoordinatorAgent.run(task)
    │
    ├── discoverAgents('research') → ResearchAgent.run(task)
    ├── discoverAgents('risk')     → RiskAgent.run(task)
    └── discoverAgents('report')  → ReportAgent.run({ task, research, risk })
                                        │
                                        ▼
                                  pay() for each agent
                                        │
                                        ▼
                                  Final Report
```

## Extending

To add a new agent type:
1. Create `src/agents/<type>/<type>.ts` with a class that has `run(task): Promise<string>`.
2. Register it in `src/coordinator/coordinator.ts`.
3. Add a discovery and call step in `CoordinatorAgent.run()`.

## Soroban contracts

`contracts/agent_registry` and `contracts/error-resolver` are the on-chain
counterparts of the Registry layer. They're separate contracts with separate
lifecycles, wired together at runtime rather than compiled together:

- **agent-registry**: agent registration, capability lookup, pricing,
  freeze/unfreeze, pause. Owns the source-of-truth `AgentRecord` per agent.
- **error-resolver**: two independent, feature-gated halves in one crate.
  The `std` feature is an off-chain Tier 1 host-error lookup table (unrelated
  to agents, no `Env`). The `contract` feature is an on-chain per-agent error
  ledger (`record_error`, `get_agent_error_count`, `clear_agent_errors`),
  gated behind an admin-managed allowlist of caller contracts.

### Cross-contract call graph

The repository defines explicit cross-contract edges for oracle price resolution, error resolution, and agent eligibility checks:

1. **`task_store` → `oracle_manager::resolve_price`**: used for price resolution fallback chains.
2. **`oracle_manager` → `price_oracle::get_price`**: fetches spot prices from external price feeds.
3. **`agent_marketplace` → `agent_registry::verify_agent_eligible`**: verifies agent existence, un-frozen state, and bond solvency prior to listing services or booking.
4. **`agent_bidding` → `agent_registry::verify_agent_eligible`**: verifies agent/task eligibility prior to accepting sealed bids.
5. **`dispute_resolution` → `agent_registry::verify_agent_eligible`**: checks target agent eligibility when filing disputes.
6. **`agent_governance` → `agent_registry::verify_agent_eligible`**: checks agent eligibility during governance stakeholder registration.

All cross-contract calls use `env.try_invoke_contract` to gracefully handle missing target contracts or typed error responses without trapping the host execution.

### Cross-contract wiring

agent-registry holds an optional `error_resolver: Address`
(`set_error_resolver`, admin only). When configured:

- `deregister_agent` calls `error_resolver.clear_agent_errors(registry_address, agent_id)`
  after removing the agent record, so an agent's error history doesn't
  outlive the agent itself.
- `get_agent_health(agent_id)` calls `error_resolver.get_agent_error_count(agent_id)`
  and folds it into the returned `AgentHealth { agent_id, exists, frozen, error_count }`.

Both calls use the SDK's `try_*` client methods rather than the panicking
variants, and both discard the `Result`: if error-resolver isn't configured,
isn't reachable, or rejects the call (not on its allowlist), agent-registry's
own operation still succeeds — cross-contract failure never blocks the
primary write. `error_count` simply reads as `0` in that case.

On the error-resolver side, `record_error` and `clear_agent_errors` require
the caller to be both (a) the genuine direct invoker of the call — proven via
`caller.require_auth()`, which a contract address satisfies automatically
when it is the one making the call, no signature needed — and (b) present in
an admin-managed allowlist (`add_authorized_caller` /
`remove_authorized_caller`). Naming the right address as an argument isn't
enough on its own; see
`caller_cannot_impersonate_another_contract_without_being_the_real_invoker`
in `contracts/agent_registry/src/lib.rs` for the test proving this.

### Cross-contract call cost

Measured via `Env::budget()` in
`cross_contract_cascade_stays_within_conservative_budget`
(`contracts/agent_registry/src/lib.rs`), simulated (not on-chain) instruction
and memory cost for `deregister_agent`:

| Scenario | CPU instructions | Memory |
|---|---|---|
| No error-resolver configured (cascade skipped) | ~69,000 | ~9.3 KB |
| With error-resolver configured (cascade runs) | ~131,000 | ~19.7 KB |
| Cost of the cross-contract call itself | ~62,000 | ~10.4 KB |

These are simulated host-side figures (rustc-compiled, not wasm), which the
SDK's own docs note tend to under-count relative to the real wasm32 runtime —
treat them as directional, not a mainnet fee quote. They're re-measured on
every `cargo test` run; the test asserts a generous (~10x observed) upper
bound so a real regression fails CI without pinning brittle exact numbers.

## Storage Layout & Bounds

Below is the canonical storage layout table for each Soroban smart contract, detailing keys, storage tiers, TTL extension policies, and explicit bounds per AGENTS.md requirements.

### `agent_registry`
| Key | Tier | TTL Strategy | Bound / Limit |
|---|---|---|---|
| `DataKey::Admin` | Instance | Contract Lifecycle | 1 Address |
| `DataKey::Paused` | Instance | Contract Lifecycle | `bool` |
| `DataKey::MinBond` | Instance | Contract Lifecycle | `i128` |
| `DataKey::GasConfig` | Instance | Contract Lifecycle | `GasConfig` struct |
| `DataKey::Agent(Symbol)` | Persistent | Extended on write/read (`TTL_THRESHOLD`=100k, `TTL_EXTEND_TO`=535,680 ledgers) | Single `AgentRecord` |
| `DataKey::CapabilityIndex(Symbol)` | Persistent | Extended on write/read | Max 500 agents per capability |
| `DataKey::FrozenAgent(Symbol)` | Persistent | Extended on write | `bool` |
| `DataKey::BondCooldown(Symbol)` | Persistent | Extended on deregister | 24-hour cooldown |

### `agent_bidding`
| Key | Tier | TTL Strategy | Bound / Limit |
|---|---|---|---|
| `DataKey::Auction(Symbol)` | Persistent | Extended on write | Single `Auction` |
| `DataKey::Bidders(Symbol)` | Persistent | Extended on write | Max 100 bidders per auction |
| `DataKey::Bid(Symbol, Address)` | Persistent | Extended on write | Single `SealedBid` |
| `DataKey::Winner(Symbol)` | Persistent | Extended on write | Single `Address` |
| `DataKey::Escrow(Symbol)` | Persistent | Extended on write | Single `Escrow` |

### `agent_governance`
| Key | Tier | TTL Strategy | Bound / Limit |
|---|---|---|---|
| `DataKey::Admin` | Instance | Contract Lifecycle | 1 Address |
| `DataKey::Paused` | Instance | Contract Lifecycle | `bool` |
| `DataKey::ParamRegistry` | Instance | Contract Lifecycle | 1 Address |
| `DataKey::TotalPower` | Instance | Contract Lifecycle | `i128` |
| `DataKey::ProposalCount` | Instance | Contract Lifecycle | `u64` |
| `DataKey::Agent(Address)` | Persistent | Extended on write | Single `AgentInfo` |
| `DataKey::Checkpoints(Address)` | Persistent | Extended on write | Max 32 `PowerCheckpoint`s per agent |
| `DataKey::Proposal(u64)` | Persistent | Extended on write | Single `Proposal`; calldata max 4096 bytes |
| `DataKey::Vote(u64, Address)` | Persistent | Extended on write | Single `VoteRecord` |

### `error-registry`
| Key | Tier | TTL Strategy | Bound / Limit |
|---|---|---|---|
| `DataKey::Record(BytesN<32>)` | Persistent | Application TTL (`expires_at`) + Extended on write/get | Single `ErrorRecord` (Max 90 days) |
| `DataKey::CodeIndex(u32)` | Persistent | Extended on write | Max 500 error IDs per code |
| `DataKey::AllErrorIds` | Persistent | Extended on write | Bounded cleanup batch (Max 100 per tx) |

### `error-resolver`
| Key | Tier | TTL Strategy | Bound / Limit |
|---|---|---|---|
| `DataKey::Admin` | Instance | Contract Lifecycle | 1 Address |
| `DataKey::AuthorizedCallers` | Instance | Contract Lifecycle | Max 32 authorized contracts |
| `DataKey::AgentErrorCount(Symbol)` | Persistent | Extended on `record_error` | `u32` counter |

## Governance (`agent_governance`)

### Admin model

The admin written by `initialize` is enforced through `require_admin`, which
loads `DataKey::Admin` and calls `require_auth()` on it. Admin-gated entry
points:

| Function | Notes |
|---|---|
| `set_admin(new_admin)` | Requires auth from **both** the current admin and `new_admin`; emits `(gov, admin_set)` with `(old, new)`. |
| `pause()` / `unpause()` | Toggle `DataKey::Paused`; emit `(gov, paused)` / `(gov, unpaused)` with the admin address. While paused, `create_proposal` and `vote_on_proposal` return `ContractPaused`. `execute_proposal` remains callable so closed votes can still be finalised. |
| `set_param_registry(registry)` | Sets the contract that `ParameterChange` proposals write through. |

`get_admin`, `is_paused` and `get_param_registry` are unauthenticated views.
The admin cannot create, vote on, or force-execute proposals.

### Execution payload

Every proposal carries an `ExecutionPayload`: `target: Option<Address>`,
`function: Symbol`, `calldata: Bytes` (max `MAX_CALLDATA_LEN` = 4096 bytes)
and an optional `expected_hash` (SHA-256 of `calldata`). The hash is verified
at creation, pinned on the proposal, and re-verified before execution.

* `ProtocolUpgrade` — `target` is required and must be a contract address
  other than the governance contract itself (`InvalidTarget` otherwise).
* `ParameterChange` — always targets the admin-configured parameter registry
  (`RegistryNotSet` if none; `InvalidTarget` if a different target is given).
  Parameters are written through the registry, never into governance storage.
* `AgentDispute` — may be signal-only (`target: None`).

When a vote passes, `execute_proposal` calls
`target.function(calldata)` via `try_invoke_contract`. The proposal becomes
`Executed` only if that invocation succeeds; a failed invocation marks it
`Failed` and the `(gov, failed)` event reports `execution_failed = true`.
Because governance is the direct invoker, the target can gate its entry point
with `governance_address.require_auth()`.

### Voting-power model

* Voting power = `stake + reputation * REPUTATION_POWER_UNIT`. Stakes are
  self-declared (no token escrow backs them yet).
* **Snapshot point:** the ledger timestamp at which the proposal is created
  (`Proposal::created_at`). The quorum denominator (`total_power_snapshot`)
  and every vote weight are both measured at this point. Vote weight is read
  from a bounded per-agent `PowerCheckpoint` history (max 32 entries), so
  raising reputation or stake mid-vote cannot inflate a vote, and agents
  registered after the snapshot cannot vote (`NoSnapshotPower`). Changes in
  the same ledger timestamp as creation are treated as part of the snapshot.
* `remove_agent` lets an agent unlock its stake and leave the electorate:
  its record is deleted, a zero checkpoint is written, and `TotalPower` is
  reduced — so aggregate power is no longer monotonically increasing. A
  removed agent cannot vote on open proposals.

