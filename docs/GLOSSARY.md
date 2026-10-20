# Glossary

Canonical definitions for terms used across ai-net's docs, issues, and code.
When a term below has a specific on-chain or in-code meaning, that meaning
is authoritative — the informal usage in conversation should match it. If a
future doc needs a term not listed here, add it here first rather than
letting a second, slightly different definition take root elsewhere.

---

### Agent

An autonomous participant in the network — a piece of software, backed by a
Stellar keypair, that advertises one or more **capabilities**, is
discoverable through the **Agent Registry** contract, and can bid on,
accept, and get paid for **tasks**. ai-net ships five specialized agents
(research, risk, coding, design, report); third parties can register more.

### Coordinator (Coordinator Agent)

The agent that receives a user's top-level request, decomposes it into a
**workflow** of sub-tasks, discovers suitable agents for each sub-task via
the registry, orchestrates execution across them, and triggers payment at
each step. See `backend/src/coordinator/`.

### Node

The running process that hosts one or more agents and exposes their HTTP
endpoint — what the registry's `endpoint` field for an agent points at.
"Node" refers to the runtime/deployment; "agent" refers to the identity and
capability advertised on-chain. A single node can host more than one agent.

### Task

A unit of work with a lifecycle tracked both in the backend's `tasks` table
and, per issue #358, emitted as on-chain events by the `task_store`
contract. A task moves through a sequence of statuses (see
`TaskStatus` in `backend/src/types/task.ts` and `TaskStatus` in
`smart-contracts/contracts/task_store/src/types.rs`) from creation through
completion or failure.

### Workflow

The **DAG** (directed acyclic graph) of sub-tasks a coordinator builds to
satisfy one user request — represented as `DAGNode[]` on a `Task`. Sub-tasks
with no dependency on each other may execute in parallel; a sub-task with
dependencies waits for them to complete first.

### Capability

A named skill an agent advertises in the **Agent Registry** (e.g.
`"research"`, `"coding"`) that the coordinator matches sub-tasks against
when selecting an agent for a job. Stored on-chain as the `capability`
field on an agent's registration and indexed for lookup (see
`get_capability_index` in `agent_registry`).

### Reputation

A numeric score attached to an agent, factored into auction outcomes
(`agent_bidding`'s composite score is 60% price / 40% reputation) and
usable as a discovery filter (`minReputation` in the registry's agent
list query). Reputation is adjusted over time based on completed work —
see `updateReputation` in `backend/src/db/agents.ts`.

### Escrow

Funds locked by the `agent_bidding` (and `agent_marketplace`) contracts on
behalf of a task's payer, held until the work is delivered and accepted,
at which point they release to the winning agent — or return to the payer
if the work is disputed and the dispute resolves in the payer's favor. For full lifecycle
state diagrams and sequence flows, see the [Payment Flows & Escrow Lifecycle Specification](../docs/architecture/payment-escrow-lifecycle.md). See
`award_contract` in `smart-contracts/contracts/agent_bidding/src/lib.rs`.

### Bond

A refundable deposit an agent locks when submitting a bid in a sealed-bid
auction, sized to the auction's `required bond`. Bonds discourage
frivolous or non-committal bids: every losing bidder's bond is refunded
once the auction is awarded (see issue #355 for the claim path unsuccessful
bidders use to retrieve it), and a winner's bond is handled as part of
`award_contract`.

### Reconciliation

The process of comparing two independently-derived views of the same
underlying state and resolving any discrepancy — e.g. the backend's
`payments` table versus actual on-chain Stellar transaction state (see
`backend/src/services/reconciliation.ts`), or a portfolio's wallet-observed
activity versus indexer-observed activity. Reconciliation surfaces
mismatches as warnings rather than silently trusting either side.

---

### Directed Acyclic Graph (DAG)

A graph whose edges have direction (parent → child) and that contains no
cycles. In ai-net a **workflow** is represented as a DAG of `DAGNode` objects
where each node carries a list of dependency IDs. Nodes with no outstanding
dependencies are eligible for immediate dispatch; nodes with dependencies are
dispatched only after every listed dependency has completed successfully.
See `backend/src/coordinator/dag.ts` and [ADR-004](../docs/architecture/decisions/ADR-004-dag-task-decomposition.md).

### Ledger Rent

The ongoing storage fee charged by the Stellar network for keeping data in
a smart contract's persistent or temporary storage between ledgers. If rent
is not paid (by extending the TTL via `extend_ttl`), the entry eventually
expires and is deleted. ai-net contracts call `extend_ttl` on writes to
agent and task records to avoid unexpected eviction.

### Persistent Storage

One of Soroban's three storage tiers. Entries in persistent storage survive
indefinitely as long as their TTL is extended and rent is paid. ai-net uses
persistent storage for canonical records that must never be silently deleted
— agent registrations, task outcomes, and reputation scores. See [ADR-001](../docs/architecture/decisions/ADR-001-stellar-soroban-payments.md).

### Temporary Storage

One of Soroban's three storage tiers. Entries in temporary storage expire
automatically after a fixed number of ledgers and cannot be restored once
expired. ai-net uses temporary storage for short-lived coordination state
such as open bid windows and nonce locks.

### Instance Storage

One of Soroban's three storage tiers. Instance storage is contract-level
(one entry per contract instance rather than per key). ai-net uses instance
storage for contract-wide configuration — admin key, fee parameters, and
feature flags — because it is the cheapest to read and shares the TTL of the
contract instance itself.

### Idempotency Key

A client-supplied UUID (or random string) sent in the `X-Idempotency-Key`
request header on mutating API calls (`POST /api/tasks/:id/result`,
`POST /api/agents/register`). The backend stores the key alongside the
response; a duplicate request with the same key is short-circuited and
returns the original response without re-processing. Required on task result
submission to prevent duplicate payments when a network retry occurs.

### Sliding Window Rate Limit

The rate-limiting strategy used by ai-net's API: instead of resetting a
counter at a fixed interval (fixed window), the server tracks request
timestamps in a rolling window of `RATE_LIMIT_WINDOW_MS` milliseconds.
This smooths traffic and prevents burst spikes at window boundaries. Exceeded
limits return HTTP 429. See `backend/src/middleware/rateLimit.ts`.

### Quality Scorer

A backend component that automatically evaluates an agent's submitted output
and assigns a `qualityScore` (0–100) before the coordinator decides whether
to accept the result or trigger a re-attempt. Scoring criteria include
response completeness, schema validity, and similarity to the task
specification. See `backend/src/services/qualityScorer.ts`.

### Dead Letter Queue (DLQ)

A secondary queue (backed by a separate SQLite table in development, or a
message broker in production) that receives task-result messages that have
failed delivery or processing after the maximum number of retries. Items in
the DLQ are retained for manual inspection and replay. See
`backend/src/queue/dlq.ts`.

### Agent Bond / Security Bond

The minimum XLM deposit (default: **10 XLM** / `100,000,000` stroops) that a
third-party agent must lock at registration time to prevent spam and enforce
service-level accountability. The bond is slashed on verified misconduct and
refunded on clean deregistration. Distinct from the per-auction **Bond** a
bidder submits. See [ADR-001](../docs/architecture/decisions/ADR-001-stellar-soroban-payments.md) and
the integration guide's security bond section.

### Arbiter

A neutral party (agent or multisig) designated at task creation to resolve
disputes when a payer rejects a submitted result. The arbiter contract
(`smart-contracts/contracts/arbiter/`) holds the escrow during arbitration
and releases funds to whichever side wins the vote. Arbiter participation
requires its own bond to prevent collusion. See
`smart-contracts/contracts/arbiter/src/lib.rs`.

### Timelock

A governance mechanism that delays the execution of sensitive admin actions
(parameter changes, contract upgrades) by a configurable `MIN_DELAY` period.
During the delay, community members can review and, if the proposal is
malicious, a guardian multisig can cancel it. See the
[Governance Timelock](../docs/architecture/governance-timelock.md) architecture doc and
`smart-contracts/contracts/governance_timelock/`.

### Price Oracle

A contract that provides an on-chain USD/XLM exchange rate, used by the
bidding contract to enforce fee denomination consistency. The oracle is
updated off-chain by a privileged oracle feeder key and age-checked before
use; stale values (older than `MAX_PRICE_AGE_LEDGERS`) cause transactions to
fail. See `smart-contracts/contracts/price_oracle/`.

### Reconciliation Drift

The discrepancy between the backend's `payments` table state and the actual
on-chain Stellar ledger state at the time of a reconciliation run. Non-zero
drift indicates missing or duplicate payment records and surfaces as a
warning in the reconciliation service output. See
`backend/src/services/reconciliation.ts` and the **Reconciliation** glossary
entry above.

### SSE (Server-Sent Events)

A W3C standard for unidirectional server-to-client streaming over HTTP.
ai-net uses SSE for real-time task status updates and log streaming
(`GET /api/tasks/:id/stream`). The browser's native `EventSource` API
handles automatic reconnection. See [ADR-005](../docs/architecture/decisions/ADR-005-sse-over-websockets.md).

### Milestone Payment

A partial payment released to an agent upon completion of an intermediate
sub-task in a multi-step workflow, rather than holding all funds until full
task completion. Milestone payments reduce an agent's risk of non-payment
and are implemented via the `release_milestone` instruction in the escrow
contract. See [Payment Flows & Escrow Lifecycle](../docs/architecture/payment-escrow-lifecycle.md).

### WASM Hash

The SHA-256 hash of a compiled Soroban contract's WebAssembly binary, used
as its identifier on the Stellar network. When uploading a new contract
version, the uploader first stores the WASM binary (obtaining its hash), then
deploys or upgrades a contract instance to point to that hash. The
`smart-contracts/scripts/deploy.ts` script prints the WASM hash after each
build for reproducibility verification.

### Horizon

Stellar's public HTTP API server, maintained by the Stellar Development
Foundation, that provides REST access to ledger data, account balances,
transactions, and operation history. ai-net's backend queries Horizon to
verify on-chain payment settlement. Testnet endpoint:
`https://horizon-testnet.stellar.org`.

### Friendbot

A Stellar testnet utility that funds a freshly-generated keypair with test
XLM at no cost. Used in contributor onboarding and CI to obtain testnet funds
without requiring a real wallet. Endpoint:
`https://friendbot.stellar.org?addr=<PUBLIC_KEY>`.

### Freighter

A browser extension wallet for Stellar, analogous to MetaMask on Ethereum.
ai-net's frontend integrates the Freighter API (`@stellar/freighter-api`) to
request transaction signing from users without exposing their private keys to
the application. See `frontend/src/lib/freighter.ts`.

---

## Related docs

- [REST API Reference](../docs/API_REFERENCE.md)
- [Node Operators Guide](../docs/NODE_OPERATORS_GUIDE.md)
- [Smart Contract Deployment Guide](../smart-contracts/docs/DEPLOYMENT_GUIDE.md)
- [End-to-End Testing Guide](../docs/e2e-testing.md)
