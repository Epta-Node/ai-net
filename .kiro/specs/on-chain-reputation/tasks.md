# Implementation Plan: On-Chain Reputation Aggregation

## Overview

Implements first-class `ReputationScore` storage in the `agent_registry` Soroban contract, driven by
task outcomes and marketplace star ratings. Changes span two Rust contracts, one new TypeScript
backend service, an event-sync update, and a frontend hook + component replacement.

Implementation order: contract data layer → contract functions → contract tests → marketplace
forwarding → backend submitter → sync handler → frontend hook → frontend component.

---

## Tasks

- [ ] 1. Extend registry error codes and DataKey variants
  - Add `InvalidRating = 27`, `RateLimitExceeded = 28`, `InvalidConfig = 29` to `errors.rs`
  - Add `Reputation(Symbol)`, `ReputationWindow(Symbol)`, `AuthorizedCallers`,
    `ReputationConfig`, `CallerWindowCount(Symbol, Address)` to the `DataKey` enum in `lib.rs`
  - Add `RegistryAddress` variant to `DataKey` in `agent_marketplace/src/lib.rs`
  - _Requirements: 1.1, 2.1, 3.1, 4.1, 5.4_

- [~] 2. Add reputation data types to registry
  - [ ] 2.1 Define `ReputationScore`, `ReputationWindow`, `OutcomeSlot`, `TaskOutcome`,
    `ReputationUpdatedEvent`, and `ReputationConfig` structs in `agent_registry/src/types.rs`
    with `#[contracttype]` and correct field types matching the design doc
    - `ReputationScore`: `agent_id: Symbol`, `composite_score: u32`, `success_rate: u32`,
      `weighted_avg_rating: u32`, `total_outcomes: u64`, `window_outcomes: u64`, `last_updated: u64`
    - `OutcomeSlot`: `success: bool`, `star_rating: u32`, `rating_weight: u32`, `caller: Address`,
      `ledger_timestamp: u64`
    - `ReputationWindow`: `slots: Vec<OutcomeSlot>`, `write_pos: u32`, `filled: u32`
    - `TaskOutcome`: `agent_id: Symbol`, `success: bool`, `response_time_ms: u32`,
      `earnings_stroops: i128`, `star_rating: Option<u32>`
    - `ReputationConfig`: `window_size: u32`, `success_weight: u32`, `rating_weight: u32`
    - `ReputationUpdatedEvent`: `agent_id: Symbol`, `composite_score: u32`, `success_rate: u32`,
      `total_outcomes: u64`, `window_outcomes: u64`
    - _Requirements: 1.2, 2.5, 4.1, 7.2_

  - [ ]* 2.2 Write property test: `TaskOutcome` with `star_rating` outside [1,5] round-trips to
    the correct error code via `Error::from_code`
    - **Property 5: Invalid star rating is rejected**
    - **Validates: Requirement 2.6**

- [~] 3. Implement reputation score calculation helpers in registry
  - [ ] 3.1 Add `REPUTATION_WINDOW_SIZE: u32 = 100`, `MAX_WEIGHT_BOND: i128 = 1_000_000_000`,
    `MIN_RATING_WEIGHT: u32 = 10`, `MAX_OUTCOMES_PER_CALLER_PER_WINDOW: u32 = 10` constants
    and a private `compute_rating_weight(bond_stroops: i128) -> u32` helper in `lib.rs`
    - Use integer arithmetic: `min(bond, MAX_WEIGHT_BOND) * 100 / MAX_WEIGHT_BOND`, floor at `MIN_RATING_WEIGHT`
    - _Requirements: 5.1, 5.2_
  - [ ] 3.2 Add private `recalculate_score(env: &Env, window: &ReputationWindow, config: &ReputationConfig, agent_id: &Symbol, total: u64) -> ReputationScore` helper
    - Iterate `window.slots[0..window.filled]`, accumulate `success_count`, `weight_sum`, `weighted_rating_sum`
    - `success_rate = success_count * 100 / window.filled` (0 when filled == 0)
    - `weighted_avg_rating = if weight_sum > 0 { weighted_rating_sum * 100 / weight_sum } else { 0 }`
    - `rating_normalized = weighted_avg_rating * 20 / 100`
    - `composite_score = clamp((config.success_weight * success_rate + config.rating_weight * rating_normalized) / 100, 0, 100)`
    - _Requirements: 5.3, 6.1, 6.2_

  - [ ]* 3.3 Write property test for composite score formula and clamp
    - **Property 12: Composite score formula is correct and always clamped**
    - **Validates: Requirements 6.1, 6.2**

  - [ ]* 3.4 Write property test for rating weight formula
    - **Property 11: Rating weight formula is correct**
    - **Validates: Requirements 5.1, 5.2, 5.3**

- [~] 4. Implement authorized caller management functions
  - [ ] 4.1 Implement `add_authorized_caller(env, caller: Address) -> Result<(), Error>` and
    `remove_authorized_caller(env, caller: Address) -> Result<(), Error>` in the
    `AgentRegistryContract` impl in `lib.rs`
    - Require `require_admin(env)?`
    - Read/write `Vec<Address>` under `DataKey::AuthorizedCallers` in Instance storage
    - Emit `(registry, auth_add)` / `(registry, auth_rem)` events carrying the `Address`
    - _Requirements: 3.1, 3.2, 3.3, 3.5_
  - [ ] 4.2 Implement `is_authorized_caller(env, caller: Address) -> bool` view function
    - Read `AuthorizedCallers` from Instance storage; return `false` if absent
    - _Requirements: 3.6_
  - [ ] 4.3 Add private `require_authorized_caller(env: &Env, caller: &Address) -> Result<(), Error>` helper
    - Returns `Err(Error::Unauthorized)` if `caller` not present in `AuthorizedCallers`
    - _Requirements: 2.2, 3.4_

  - [ ]* 4.4 Write property test for authorized caller add/remove round-trip
    - **Property 4: Authorized caller add/remove round-trip**
    - **Validates: Requirements 3.2, 3.3**

  - [ ]* 4.5 Write property test for unauthorized caller rejection
    - **Property 3: Unauthorized callers are rejected**
    - **Validates: Requirements 2.2, 3.4**

- [~] 5. Implement reputation config management
  - [ ] 5.1 Implement `set_reputation_config(env, window_size: u32, success_weight: u32, rating_weight: u32) -> Result<(), Error>`
    - Require `require_admin(env)?` and `require_not_paused(env)?`
    - Validate `window_size` in [10, 500]; validate `success_weight + rating_weight == 100`
    - Write `ReputationConfig` to Instance storage under `DataKey::ReputationConfig`
    - _Requirements: 4.5, 6.5_
  - [ ] 5.2 Implement `get_reputation_window_size(env) -> u32` view function
    - Return `config.window_size` from Instance storage, defaulting to `REPUTATION_WINDOW_SIZE`
    - _Requirements: 4.4_

  - [ ]* 5.3 Write property test for window config validation
    - **Property 9: Window config validates bounds**
    - **Validates: Requirements 4.5, 6.5**

- [~] 6. Implement `get_reputation` and `get_composite_score` view functions
  - [ ] 6.1 Implement `get_reputation(env, agent_id: Symbol) -> ReputationScore`
    - Read `DataKey::Reputation(agent_id)` from Persistent storage; return default score
      (`composite_score=50`, all counters 0) when absent
    - Call `extend_ttl_for_key` after read
    - _Requirements: 1.1, 1.3, 1.4, 1.5_
  - [ ] 6.2 Implement `get_composite_score(env, agent_id: Symbol) -> u32`
    - Delegate to `get_reputation` and return only `.composite_score`
    - _Requirements: 6.4_

  - [ ]* 6.3 Write property test: reputation score round-trip
    - **Property 1: Reputation score round-trip**
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [ ]* 6.4 Write unit test: default score for agent with no outcomes
    - **Property 2: Default score for agent with no outcomes (example)**
    - **Validates: Requirement 1.4**

- [~] 7. Implement `record_task_outcome` (single) in registry
  - [ ] 7.1 Implement `record_task_outcome(env, caller: Address, outcome: TaskOutcome) -> Result<(), Error>`
    - Call `caller.require_auth()` first
    - Call `require_not_paused(env)?`
    - Call `require_authorized_caller(env, &caller)?`
    - Return `Err(Error::NotFound)` if `outcome.agent_id` absent from Agent storage
    - Validate `star_rating` in Some(1..=5) or None; return `Err(Error::InvalidRating)` otherwise
    - Read `CallerWindowCount(agent_id, caller)` from Temporary storage; return
      `Err(Error::RateLimitExceeded)` if count >= `MAX_OUTCOMES_PER_CALLER_PER_WINDOW`
    - Compute `rating_weight` via `compute_rating_weight` (read caller bond from registry)
    - Load `ReputationWindow` from `DataKey::ReputationWindow(agent_id)` (or create fresh one)
    - Write outcome into `slots[write_pos]`, advance `write_pos = (write_pos + 1) % window_size`,
      increment `filled` up to `window_size`, increment `window_outcomes`
    - Load `ReputationScore` (or default), increment `total_outcomes`
    - Call `recalculate_score` and write updated `ReputationScore` and `ReputationWindow` to Persistent storage
    - Call `extend_ttl_for_key` for both keys
    - Increment `CallerWindowCount` in Temporary storage
    - Emit `(registry, rep_upd)` event with `ReputationUpdatedEvent` payload
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 4.1, 4.2, 5.4, 5.5, 7.1, 7.2_

  - [ ]* 7.2 Write unit test: `rep_upd` event emitted on successful outcome recording
    - **Property 7.1 (example): rep_upd event emitted**
    - **Validates: Requirement 7.1**

  - [ ]* 7.3 Write unit test: paused contract rejects `record_task_outcome`
    - **Validates: Requirement 2.3**

  - [ ]* 7.4 Write property test: rolling window size is bounded
    - **Property 8: Rolling window size is bounded**
    - **Validates: Requirements 4.1, 4.2**

  - [ ]* 7.5 Write property test: per-caller rate limit is enforced
    - **Property 10: Per-caller rate limit is enforced**
    - **Validates: Requirement 5.5**

  - [ ]* 7.6 Write unit test: unknown agent returns NotFound
    - **Property 6: Unknown agent returns NotFound**
    - **Validates: Requirement 2.4**

- [~] 8. Implement `record_task_outcomes` batch variant in registry
  - [ ] 8.1 Implement `record_task_outcomes(env, caller: Address, outcomes: Vec<TaskOutcome>) -> Result<Vec<VoidBatchResult>, Error>`
    - Call `caller.require_auth()` once for the batch
    - First pass: validate each outcome (auth, paused, agent existence, rating bounds, rate limit);
      collect `VoidBatchResult` per item
    - If any item has `VoidBatchResult::Err`, return the results vector without writing any state
    - Second pass: write all outcomes and emit one `(registry, rep_upd)` event per item
    - _Requirements: 2.8, 7.3_

  - [ ]* 8.2 Write property test: batch is atomic — one invalid entry prevents all writes
    - **Property 7: Batch is atomic — one invalid entry prevents all writes**
    - **Validates: Requirement 2.8**

  - [ ]* 8.3 Write property test: one `rep_upd` event emitted per batch item
    - **Property 13: One rep_upd event emitted per batch item**
    - **Validates: Requirement 7.3**

- [~] 9. Update `discover_agents` to use on-chain composite score
  - Replace the `get_metadata_u32` reputation lookup in the `discover_agents` function with a
    direct `env.storage().persistent().get::<DataKey, ReputationScore>(&DataKey::Reputation(agent_id))`
    read, falling back to `50` (the default) when absent
  - _Requirements: 6.3_

- [~] 10. Checkpoint — verify registry contract compiles and all tests pass
  - Run `cd smart-contracts && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test -p agent-registry`
  - Ensure all tests pass; ask the user if questions arise.

- [~] 11. Add reputation event types to `events.rs` and marketplace `rep_fwd` type
  - Add `AuthCallerAddedEvent { caller: Address }` and `AuthCallerRemovedEvent { caller: Address }`
    to `agent_registry/src/events.rs`
  - Add `RepForwardedEvent { agent_id: Symbol, star_rating: u32 }` to
    `agent_marketplace/src/types.rs` for the `(marketplace, rep_fwd)` event
  - _Requirements: 3.5, 8.5_

- [~] 12. Implement marketplace cross-contract forwarding in `rate_booking`
  - [ ] 12.1 Add `RegistryAddress` variant to `DataKey` enum in `agent_marketplace/src/lib.rs`
    (already listed in task 1 — wire it up here)
  - [ ] 12.2 Add `set_registry_address(env, addr: Address) -> Result<(), Error>` admin function
    to `AgentMarketplaceContract` that writes `addr` to Instance storage under `DataKey::RegistryAddress`
    - Require `require_admin(env)?`
    - _Requirements: 8.2_
  - [ ] 12.3 Modify `rate_booking` to emit `(marketplace, rep_fwd)` and attempt the cross-contract
    `record_task_outcome` call after the local rating write succeeds
    - Read `DataKey::RegistryAddress` from Instance storage; skip forwarding if absent
    - Build `TaskOutcome { agent_id: booking.agent_id, success: true, response_time_ms: 0, earnings_stroops: 0, star_rating: Some(rating) }`
    - Use `env.invoke_contract::<_, _, Result<(), _>>` in a `match` / `if let Err` pattern (non-panicking) and discard errors
    - Emit `(marketplace, rep_fwd)` event with `RepForwardedEvent` payload before the cross-contract call regardless of result
    - _Requirements: 8.1, 8.3, 8.4, 8.5_

  - [ ]* 12.4 Write unit test: cross-contract forwarding failure does not block `rate_booking`
    - **Validates: Requirement 8.3**

- [~] 13. Checkpoint — verify marketplace contract compiles and tests pass
  - Run `cd smart-contracts && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test -p agent-marketplace`
  - Ensure all tests pass; ask the user if questions arise.

- [~] 14. Create `ReputationSubmitter` backend service
  - [ ] 14.1 Create `backend/src/services/reputationSubmitter.ts` with the `ReputationSubmitter` class
    - Constructor: accepts `contractId: string`, `signerKeypair: Keypair`, `db: Database.Database`,
      `options?: { maxRetries?: number; backoffBaseMs?: number }`
    - `async submitOutcome(taskId: string, nodeId: string, agentId: string, success: boolean): Promise<void>`
      - Query SQLite for `client_rating` on the task; include `star_rating` only when non-null
      - Build `TaskOutcome` xdr object and sign with `signerKeypair`
      - Submit to contract via `SorobanRpc.Server.sendTransaction` with exponential backoff
      - Retry up to `maxRetries` (default 3) on `tx_too_late`, `TOO_MANY_REQUESTS`, network errors
      - Log `ERROR` and skip retry for `Error::NotFound` (27→1), `Error::Unauthorized` (2) responses
      - Log `WARN` and skip retry for `Error::RateLimitExceeded` (28)
    - Export `OnChainReputationScore` and `ReputationUpdatedPayload` TypeScript interfaces
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [ ]* 14.2 Write unit tests in `backend/src/services/reputationSubmitter.test.ts`
    - Test `submitOutcome` calls contract after task completion (mock Soroban RPC)
    - Test `star_rating` absent when `client_rating` is NULL; present when non-null
    - **Validates: Requirements 9.1, 9.5**

  - [ ]* 14.3 Write property test: retry submitter behaviour
    - **Property 14: Retry submitter behaviour (backend)**
    - Use `fast-check` to generate sequences of retryable/non-retryable errors
    - **Validates: Requirements 9.3, 9.4**

  - [ ]* 14.4 Write property test: `star_rating` included iff `client_rating` is present
    - **Property 15: star_rating is included iff client_rating is present (backend)**
    - **Validates: Requirement 9.5**

- [~] 15. Wire `ReputationSubmitter` into coordinator task completion
  - In the coordinator's task dispatch / DAG execution path (locate `record_task_completion` or
    equivalent status-change site in backend), instantiate or inject `ReputationSubmitter` and call
    `submitOutcome` when a node transitions to `completed` or `failed`
  - Submission must fire within the same async turn; failures must not throw to the caller
  - _Requirements: 9.1, 9.2_

- [~] 16. Add `rep_upd` event handler to `backend/src/registry/sync.ts`
  - [ ] 16.1 Add `REP_UPD: "rep_upd"` to the `TOPICS` constant map in `sync.ts`
  - [ ] 16.2 Add `ReputationUpdatedPayload` interface (mirrors on-chain event struct)
  - [ ] 16.3 Add a `case TOPICS.REP_UPD:` branch in `handleEvent` that calls
    `db.updateReputation(data.agent_id, data.composite_score)` — replace the delta-based call
    with an absolute-set variant; update `AgentDb.updateReputation` signature if needed
  - Note: the existing `updateReputation(id, delta)` in `db/agents.ts` applies a delta; add an
    `setReputation(id: string, score: number): void` method that does an absolute UPDATE instead,
    and use that here
  - _Requirements: 7.4_

  - [ ]* 16.4 Write unit test: `rep_upd` event handler updates `agents.reputation_score` in SQLite
    - **Validates: Requirement 7.4**

- [~] 17. Checkpoint — verify backend compiles, lints, and tests pass
  - Run `cd backend && npm run lint && npm test`
  - Ensure all tests pass; ask the user if questions arise.

- [~] 18. Update `useAgentReputation` frontend hook to read from contract
  - [ ] 18.1 Replace the `getAgentReputation` API call in `frontend/src/hooks/useAgentReputation.ts`
    with a Stellar SDK `simulateTransaction` call to `get_reputation(agentId)` on the Registry
    contract (read `VITE_REGISTRY_CONTRACT_ID` and `VITE_SOROBAN_RPC_URL` from env)
  - [ ] 18.2 Export `OnChainReputationScore` interface matching the on-chain struct:
    `{ agentId, compositeScore, successRate, weightedAvgRating, totalOutcomes, windowOutcomes, lastUpdated }`
  - [ ] 18.3 Hook return type: `{ data: OnChainReputationScore | null; loading: boolean; error: string | null }`
    - Return `data: null` and set `error` string on RPC failure; never throw
  - _Requirements: 10.1, 10.4_

  - [ ]* 18.4 Write unit tests in `frontend/src/hooks/useAgentReputation.test.ts`
    - Test hook calls contract simulation, not backend API endpoint
    - Test `data` is null and `error` is set when RPC throws
    - **Validates: Requirements 10.1, 10.4**

  - [ ]* 18.5 Write property test: star display mapping formula
    - **Property 16: Star display mapping is correct (frontend)**
    - Use `fast-check` to verify `max(1, min(5, Math.ceil(score / 20)))` for all `score` in [0, 100]
    - **Validates: Requirement 10.3**

- [~] 19. Update `ReputationStars` component to consume on-chain score
  - [ ] 19.1 Update `frontend/src/components/agents/ReputationStars.tsx` to accept
    `compositeScore: number` (0–100) and `windowOutcomes?: number` props instead of `value: number`
  - [ ] 19.2 Compute `stars = Math.max(1, Math.min(5, Math.ceil(compositeScore / 20)))` inside the component
  - [ ] 19.3 Add a `title` tooltip of the form `"Based on last N tasks"` where N = `windowOutcomes`
    when provided; show `"No task data yet"` when absent or 0
  - [ ] 19.4 Render grey placeholder stars (using `className` variant or opacity) when
    `compositeScore` is undefined / component receives no data (null state from hook)
  - [ ] 19.5 Update all call-sites that pass `value=` to pass `compositeScore=` instead; wire in the
    `useAgentReputation` hook at the call-site if not already done
  - _Requirements: 10.2, 10.3, 10.4, 10.5_

  - [ ]* 19.6 Write property test: tooltip reflects window_outcomes count
    - **Property 17: Tooltip reflects window_outcomes count (frontend)**
    - **Validates: Requirement 10.5**

- [~] 20. Final checkpoint — verify frontend builds and lints clean
  - Run `cd frontend && npm run lint && npm run build`
  - Ensure no type errors or lint warnings; ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP delivery
- Property tests use **proptest** (Rust) and **fast-check** (TypeScript)
- Each property test must include the comment `// Feature: on-chain-reputation, Property N: <text>`
- `record_task_outcome` must call `caller.require_auth()` before any storage reads (AGENTS.md Stellar invariant)
- `AuthorizedCallers` and `ReputationConfig` use Instance storage (singletons, no per-key TTL)
- `Reputation(agent_id)` and `ReputationWindow(agent_id)` use Persistent storage with TTL extension
- `CallerWindowCount` uses Temporary storage and auto-expires — no explicit cleanup needed
- The marketplace cross-contract call is non-panicking: a paused or misconfigured registry must never block `rate_booking`
