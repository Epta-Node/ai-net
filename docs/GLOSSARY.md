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

### Soroban

Stellar's smart contract platform. An ai-net contract compiles to WebAssembly (Wasm) and runs at a contract address on the Stellar network. Its code can read ledger state and request authorization from an account or another contract. [WASM Hash](#wasm-hash) · [require_auth](#require_auth)

### Ledger Entry

A record in Stellar's ledger state with a key that identifies it. Accounts, contract code, and contract data are examples. A single contract can own many data entries. [Persistent Storage](#persistent-storage)

### TTL

Time to live, measured in ledgers. A contract entry remains live through its last live ledger sequence. Extending its TTL moves that boundary forward. At expiry, the storage type determines whether the data can be restored. [Persistent Storage](#persistent-storage) · [Temporary Storage](#temporary-storage)

### Ledger Rent

The resource fee for keeping contract code or data live over a number of ledgers. The size of an entry and the duration of an extension affect rent. [TTL](#ttl)

### Persistent Storage

Each key has its own ledger entry and TTL. Use it for records such as balances that must remain recoverable. Expired persistent entries are archived and can be restored. [Stellar storage guide](https://developers.stellar.org/docs/build/guides/storage/use-persistent)

### Temporary Storage

Each key has its own TTL. Expiration permanently removes the value, making this tier suitable for data such as a short-lived lock. [TTL](#ttl)

### Instance Storage

Small contract-wide settings, such as an admin address, can live inside the contract instance entry. All keys in instance storage share that entry's TTL and are archived and restored with it. [Ledger Entry](#ledger-entry)

### require_auth

A Soroban SDK method that asks the host to verify an address authorized the current invocation. For a privileged operation, the contract selects or checks the permitted address and calls `require_auth()` on it. [Smart Contract Upgrade](#smart-contract-upgrade)

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

The SHA-256 digest of the compiled WebAssembly bytes. Uploading code makes it available by this hash. Multiple contract instances can reference the same code while keeping separate addresses and state. [Smart Contract Upgrade](#smart-contract-upgrade)

### Smart Contract Upgrade

An existing instance switches to a new uploaded Wasm hash through its upgrade logic. Its address and data persist. If the new code expects a different data layout, the upgrade needs a compatible reader or a migration. [Upgrade guide](../smart-contracts/docs/UPGRADE_GUIDE.md) · [Storage migration](../smart-contracts/docs/STORAGE_MIGRATION.md)

### Testnet

Stellar's public development network. Test XLM pays for transactions, and periodic resets clear accounts and deployments. [Friendbot](#friendbot) · [Stellar networks](https://developers.stellar.org/docs/networks)

### Mainnet

Stellar's production network, where transactions move real assets. Mainnet has its own ledger and network passphrase, so clients must select it explicitly when signing for production. [Testnet](#testnet)

### Horizon

Stellar's REST API for indexed account, transaction, and operation history. The market-report E2E test looks up payment operations through Horizon to check what was released. [E2E guide](./e2e-testing.md)

### RPC

Stellar Remote Procedure Call service. A contract client can simulate an invocation, submit a signed transaction, query its result, and read ledger entries. [Ledger Entry](#ledger-entry) · [Stellar RPC](https://developers.stellar.org/docs/data/apis/rpc)

### Friendbot

A faucet that accepts a public address and funds it with test XLM. The market-report E2E suite uses it to fund the coordinator and agent before exercising payments. [Testnet](#testnet)

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
