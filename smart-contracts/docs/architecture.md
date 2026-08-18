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
