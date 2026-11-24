# Requirements Document

## Introduction

The `on-chain-reputation` feature replaces the current off-chain `reputation` metadata field in `AgentRecord`
with a first-class, self-contained `ReputationScore` stored directly on the `agent_registry` Soroban contract.
Reputation will be aggregated from two signals — task success rate and marketplace star ratings — updated at task
completion time with decay applied via a rolling window, and protected against low-rating flooding through
stake-weighted event contributions. A single contract read will return the full score, removing the off-chain
dependency that currently makes `ReputationStars` unreliable.

Affected layers:
- **Smart contracts**: `agent_registry` (primary), `agent_marketplace` (cross-contract write)
- **Backend**: coordinator submits task outcomes; indexer reads updated scores
- **Frontend**: `ReputationStars` component reads the on-chain score instead of backend stats

---

## Glossary

- **Registry**: The `agent_registry` Soroban smart contract — the authoritative on-chain store for agent records.
- **Marketplace**: The `agent_marketplace` Soroban smart contract — handles bookings and star ratings.
- **ReputationScore**: The on-chain struct stored per agent aggregating success rate and star ratings into a single composite score [0, 100].
- **Coordinator**: The off-chain TypeScript coordinator service that dispatches tasks and submits task outcomes to the Registry.
- **AuthorizedCaller**: An address registered on an admin-managed allowlist that is permitted to call `record_task_outcome` on the Registry.
- **TaskOutcome**: A single task completion record carrying agent ID, success flag, response time, earnings, and client star rating.
- **DecayWindow**: The rolling count of the most recent N task outcomes that contribute to the score; older outcomes outside this window are excluded from aggregation.
- **RatingWeight**: A per-submission weight (0, 1] derived from the submitter's bond amount that dampens low-bond flooding attacks.
- **CompositeScore**: The final [0, 100] integer combining weighted success rate (60%) and weighted average star rating (40%).
- **ReputationUpdatedEvent**: The Soroban event emitted after every successful `record_task_outcome` call.

---

## Requirements

### Requirement 1: On-Chain Reputation Storage

**User Story:** As a client agent, I want to read an agent's reputation in a single contract call, so that I can make trust decisions without relying on off-chain data.

#### Acceptance Criteria

1. THE Registry SHALL store a `ReputationScore` struct per agent in `Persistent` storage under a `DataKey::Reputation(agent_id)` key.
2. THE `ReputationScore` struct SHALL contain: `agent_id: Symbol`, `composite_score: u32` [0, 100], `success_rate: u32` [0, 100], `weighted_avg_rating: u32` [0, 500] (scaled by 100 to avoid decimals), `total_outcomes: u64`, `window_outcomes: u64`, `last_updated: u64`.
3. WHEN a client calls `get_reputation(agent_id)`, THE Registry SHALL return the current `ReputationScore` in a single storage read without invoking any cross-contract call.
4. WHEN `get_reputation` is called for an agent with no recorded outcomes, THE Registry SHALL return a default `ReputationScore` with `composite_score` = 50 and all counters set to 0.
5. THE Registry SHALL extend the TTL of each `DataKey::Reputation` entry to `TTL_EXTEND_TO` ledgers whenever the entry is written or read, consistent with the existing `extend_ttl_for_key` pattern.

---

### Requirement 2: Task Outcome Recording

**User Story:** As the coordinator service, I want to submit task completion data to the contract, so that on-chain reputation stays synchronized with real execution results.

#### Acceptance Criteria

1. THE Registry SHALL expose a `record_task_outcome(env, caller, outcome: TaskOutcome) -> Result<(), Error>` function.
2. WHEN `record_task_outcome` is called, THE Registry SHALL require `caller.require_auth()` and verify `caller` is present in the `AuthorizedCallers` allowlist before modifying any state.
3. IF the contract is paused, THEN THE Registry SHALL return `Error::ContractPaused` without modifying state.
4. IF `outcome.agent_id` does not exist in the Registry, THEN THE Registry SHALL return `Error::NotFound`.
5. THE `TaskOutcome` struct SHALL contain: `agent_id: Symbol`, `success: bool`, `response_time_ms: u32`, `earnings_stroops: i128`, `star_rating: Option<u32>` (1–5 or absent).
6. IF `outcome.star_rating` is `Some(r)` and `r` is outside [1, 5], THEN THE Registry SHALL return `Error::InvalidRating`.
7. WHEN a valid `record_task_outcome` call is processed, THE Registry SHALL append the outcome to the agent's rolling window and recalculate `ReputationScore` atomically within the same transaction.
8. THE Registry SHALL also accept a `record_task_outcomes(env, caller, outcomes: Vec<TaskOutcome>) -> Result<Vec<VoidBatchResult>, Error>` batch variant that validates all items before writing any state, following the existing `register_agents` batch-atomic pattern.

---

### Requirement 3: Authorized Caller Management

**User Story:** As the contract admin, I want to control which addresses may submit task outcomes, so that reputation data cannot be fabricated by unauthorized parties.

#### Acceptance Criteria

1. THE Registry SHALL maintain an `AuthorizedCallers` set in `Instance` storage.
2. WHEN `add_authorized_caller(env, caller: Address)` is called by the admin, THE Registry SHALL add `caller` to the `AuthorizedCallers` set.
3. WHEN `remove_authorized_caller(env, caller: Address)` is called by the admin, THE Registry SHALL remove `caller` from the `AuthorizedCallers` set.
4. IF `record_task_outcome` is called by an address not in `AuthorizedCallers`, THEN THE Registry SHALL return `Error::Unauthorized`.
5. THE Registry SHALL emit a `(registry, auth_add)` event when a caller is added and a `(registry, auth_rem)` event when a caller is removed, each carrying the affected `Address`.
6. THE Registry SHALL expose `is_authorized_caller(env, caller: Address) -> bool` for off-chain verification without requiring admin auth.

---

### Requirement 4: Rolling Decay Window

**User Story:** As a client agent, I want recent task performance to matter more than old history, so that a previously poor agent that has improved is not permanently penalised.

#### Acceptance Criteria

1. THE Registry SHALL store at most `REPUTATION_WINDOW_SIZE` = 100 outcome slots per agent in a fixed-size circular buffer keyed under `DataKey::ReputationWindow(agent_id)`.
2. WHEN a new outcome is recorded and the buffer already contains `REPUTATION_WINDOW_SIZE` entries, THE Registry SHALL overwrite the oldest entry (FIFO eviction) without growing storage.
3. THE Registry SHALL derive `ReputationScore.success_rate` and `ReputationScore.weighted_avg_rating` exclusively from the outcomes currently present in the rolling window.
4. THE Registry SHALL expose a `get_reputation_window_size() -> u32` view function that returns the current configured `REPUTATION_WINDOW_SIZE` constant.
5. WHERE the admin configures a custom window size via `set_reputation_config`, THE Registry SHALL accept values in [10, 500] and reject values outside this range with `Error::InvalidConfig`.

---

### Requirement 5: Stake-Weighted Rating Contributions

**User Story:** As a legitimate agent, I want low-bond callers to have reduced influence over my reputation, so that a malicious actor cannot flood the contract with damaging ratings at low cost.

#### Acceptance Criteria

1. WHEN `record_task_outcome` is called with a `star_rating`, THE Registry SHALL compute a `RatingWeight` for the submission: `weight = min(caller_bond_stroops, MAX_WEIGHT_BOND) / MAX_WEIGHT_BOND` where `MAX_WEIGHT_BOND` = 1,000,000,000 stroops (100 XLM).
2. IF the submitting `caller` has no bond recorded in the Registry, THE Registry SHALL use a `RatingWeight` of `MIN_RATING_WEIGHT` = 0.1 (stored as integer 10 out of 100).
3. THE Registry SHALL compute `weighted_avg_rating` as `sum(star_rating_i * weight_i) / sum(weight_i)` over the current window, using integer arithmetic scaled by 100 to preserve two decimal places.
4. THE Registry SHALL store per-window-slot `rating_weight: u32` alongside each outcome in the circular buffer.
5. WHEN a caller submits more than `MAX_OUTCOMES_PER_CALLER_PER_WINDOW` = 10 outcomes within the current window for the same agent, THE Registry SHALL return `Error::RateLimitExceeded` and reject the submission.

---

### Requirement 6: Composite Score Calculation

**User Story:** As a client agent discovering agents via the discovery oracle, I want a single numeric score that reflects both reliability and quality, so that I can rank agents consistently.

#### Acceptance Criteria

1. WHEN a `ReputationScore` is recalculated, THE Registry SHALL compute: `composite_score = round(0.60 * success_rate + 0.40 * (weighted_avg_rating * 20))` where `weighted_avg_rating` is on the [1, 5] star scale, normalised to [0, 100] by multiplying by 20.
2. THE `composite_score` SHALL always be clamped to [0, 100] after calculation.
3. THE Registry SHALL replace the existing `get_metadata_u32` reputation lookup in `discover_agents` with a direct read from `DataKey::Reputation(agent_id).composite_score`.
4. THE Registry SHALL expose `get_composite_score(agent_id: Symbol) -> u32` as a lightweight view function returning only the composite score without the full `ReputationScore` struct.
5. WHERE the admin sets custom score weights via `set_score_weights(success_weight: u32, rating_weight: u32)`, THE Registry SHALL require `success_weight + rating_weight == 100` and reject mismatched values with `Error::InvalidConfig`.

---

### Requirement 7: Reputation Events

**User Story:** As a backend indexer, I want to receive an on-chain event on every reputation update, so that I can maintain a synchronized off-chain cache without polling.

#### Acceptance Criteria

1. WHEN `record_task_outcome` successfully updates a `ReputationScore`, THE Registry SHALL emit a `(registry, rep_upd)` event with a `ReputationUpdatedEvent` payload.
2. THE `ReputationUpdatedEvent` struct SHALL contain: `agent_id: Symbol`, `composite_score: u32`, `success_rate: u32`, `total_outcomes: u64`, `window_outcomes: u64`.
3. THE Registry SHALL emit a single `(registry, rep_upd)` event per batch item when processing `record_task_outcomes`, not one event for the entire batch.
4. THE backend SHALL subscribe to `(registry, rep_upd)` events via Horizon streaming and update its SQLite `agents` table `reputation_score` column on receipt, replacing the current off-chain stats-derived value.

---

### Requirement 8: Marketplace Rating Cross-Contract Forwarding

**User Story:** As a marketplace client, I want star ratings submitted after booking completion to flow into the on-chain reputation automatically, so that ratings are not siloed in the marketplace contract.

#### Acceptance Criteria

1. WHEN `agent_marketplace.rate_booking` succeeds, THE Marketplace SHALL invoke `agent_registry.record_task_outcome` via a cross-contract call with the booking's star rating and `success = true`.
2. THE Marketplace SHALL read the Registry address from its `Instance` storage key `RegistryAddress`, set at initialization or by admin.
3. IF the cross-contract call to the Registry fails (Registry paused, agent deregistered, or Registry not configured), THEN THE Marketplace SHALL still complete the local rating write successfully, following the existing non-blocking cross-contract pattern used by `error_resolver`.
4. THE Marketplace SHALL use the `try_record_task_outcome` SDK client method (non-panicking variant) and discard the `Result` on failure.
5. THE Marketplace SHALL emit a `(marketplace, rep_fwd)` event with `agent_id` and `star_rating` whenever the forwarding call is attempted, regardless of whether it succeeds or fails, so indexers can detect forwarding gaps.

---

### Requirement 9: Backend Coordinator Integration

**User Story:** As the platform, I want the TypeScript coordinator to submit task outcomes on-chain after every task completes, so that registry reputation stays up to date.

#### Acceptance Criteria

1. WHEN a task transitions to `completed` or `failed` status in the backend, THE Coordinator SHALL invoke `record_task_outcome` on the Registry contract within 30 seconds of status change.
2. THE Coordinator SHALL sign `record_task_outcome` calls with a keypair whose address has been added to `AuthorizedCallers` via `add_authorized_caller`.
3. IF the on-chain call fails with a retryable error (network timeout, ledger congestion), THEN THE Coordinator SHALL retry with exponential backoff up to 3 attempts before logging the failure and continuing.
4. IF the on-chain call fails with a non-retryable error (`Error::NotFound`, `Error::Unauthorized`), THEN THE Coordinator SHALL log the failure at `ERROR` severity and skip retry.
5. THE Coordinator SHALL include a `star_rating` in the `TaskOutcome` only when the task record in SQLite has a non-null `client_rating` field at submission time.

---

### Requirement 10: Frontend Reputation Display

**User Story:** As a platform user, I want agent reputation scores displayed in the UI to reflect on-chain data, so that I can trust the scores are accurate and tamper-resistant.

#### Acceptance Criteria

1. THE Frontend SHALL read agent reputation by calling `get_reputation(agent_id)` on the Registry contract, replacing any backend API reputation endpoint.
2. THE Frontend SHALL display `ReputationScore.composite_score` as the primary star/score indicator in the `ReputationStars` component.
3. WHEN `composite_score` is between 0 and 100, THE Frontend SHALL map the value to a 1–5 star visual using `stars = ceil(composite_score / 20)`, clamped to [1, 5].
4. WHEN the on-chain read fails or returns no data, THE Frontend SHALL display a neutral placeholder (e.g., grey stars) rather than a stale or fabricated score.
5. THE Frontend SHALL display `window_outcomes` as a tooltip showing "based on last N tasks" so users can assess score confidence.
