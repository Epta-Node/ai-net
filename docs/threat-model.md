# ai-net Threat Model

## Assets

- Task prompts, prompt hashes, compressed DAGs, and agent outputs.
- Submitter wallets, payment escrow state, and reconciliation records.
- Agent reputation, bid commitments, reveal data, and refund state.
- Backend API availability and websocket task streams.

## Trust Boundaries

| Boundary | Risks | Required Controls |
| --- | --- | --- |
| Wallet to frontend | spoofed accounts, wrong network, replayed signatures | explicit network display, challenge freshness, signature purpose binding |
| Frontend to backend | oversized payloads, auth confusion, stale task reads | schema validation, rate limits, request ids, tenant/task authorization |
| Backend to agents | forged assignments, replayed results, unavailable agents | signed dispatch payloads, idempotency keys, heartbeat expiry |
| Backend to Stellar | stale ledger reads, failed submissions, reconciliation drift | retry budget, event indexing, periodic reconciliation |
| Contracts to indexers | missed lifecycle events, ambiguous terms | typed event payloads, stable glossary terms, replayable indexes |

## Primary Abuse Cases

- A bidder loses an auction and cannot independently recover bond state if award execution is delayed.
- A coordinator or indexer misses a task transition because lifecycle events are not explicit.
- A degraded dependency keeps receiving production traffic because readiness does not include dependency probes.
- A shutdown interrupts task dispatch, websocket streams, or reconciliation before state is flushed.

## Required Mitigations

- Emit explicit task lifecycle events for on-chain task state changes.
- Provide liveness, readiness, and dependency health probes for deployment platforms.
- Drain HTTP and websocket traffic before closing databases and background workers.
- Keep migration rollbacks deterministic and operator-invokable.
- Document vulnerability reporting, triage targets, and coordinated disclosure expectations.
