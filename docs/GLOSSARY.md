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
if the work is disputed and the dispute resolves in the payer's favor. See
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

## Related docs

- [REST API Reference](../docs/API_REFERENCE.md)
- [Node Operators Guide](../docs/NODE_OPERATORS_GUIDE.md)
- [Smart Contract Deployment Guide](../smart-contracts/docs/DEPLOYMENT_GUIDE.md)
- [End-to-End Testing Guide](../docs/e2e-testing.md)
