# AI-Net Canonical Event Schema

This document is the authoritative reference for every event emitted by the
ai-net backend event-sourcing system. It covers schema design, versioning
rules, per-version field additions, migration guidance for consumers, and
a worked example for each event type.

---

## 1. Design Principles

| Principle                         | Description                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Discriminated union**           | Every event carries a `type` field that identifies the concrete shape.                             |
| **Versioned payloads**            | Every event record carries a `version` integer. Consumers branch on this value.                    |
| **Append-only within a version**  | Adding new optional fields does NOT require a version bump — consumers tolerate unknown fields.    |
| **Breaking changes bump version** | Removing, renaming, or changing the type of an existing field requires a version bump.             |
| **Stable topic pairs**            | The `(type)` discriminator is stable across versions; a schema change bumps `version`, not `type`. |

---

## 2. Base Event Envelope

Every event, regardless of type, shares these base fields:

```jsonc
{
  "type": "TaskCreated", // Discriminator — identifies the concrete shape
  "taskId": "task_abc123", // The task this event belongs to
  "occurredAt": "2026-08-31T12:00:00.000Z", // ISO-8601 wall-clock time
  "version": 2, // Schema version (integer, >= 1)
  "globalSeq": 42, // Globally-ordered sequence (assigned on persist)
  "taskSeq": 0, // Per-task monotonic cursor (assigned by EventBus)
}
```

---

## 3. Event Types and Version History

| Event                 | v1  | v2  | Notes                                    |
| --------------------- | --- | --- | ---------------------------------------- |
| `TaskCreated`         | ✅  | ✅  |                                          |
| `NodeStarted`         | ✅  | ✅  |                                          |
| `NodeCompleted`       | ✅  | ✅  |                                          |
| `NodeFailed`          | ✅  | ✅  |                                          |
| `PaymentLocked`       | ✅  | ✅  |                                          |
| `PaymentReleased`     | ✅  | ✅  |                                          |
| `TaskCompleted`       | ✅  | ✅  |                                          |
| `TaskFailed`          | ✅  | ✅  |                                          |
| `ReconciliationEvent` | ✅  | ✅  | Added by issue #496 — same shape in both |

### 3.1 TaskCreated

Emitted when a task is created and enqueued.

#### Version 1

```jsonc
{
  "type": "TaskCreated",
  "taskId": "task_abc123",
  "occurredAt": "2026-08-31T12:00:00.000Z",
  "version": 1,
  "payload": {
    "prompt": "Analyze Stellar DEX liquidity trends",
    "walletPublicKey": "GBZXN7...AAA",
    "dagSize": 3,
  },
}
```

#### Version 2 (current)

Adds optional `agentId` and `durationMs` fields.

```jsonc
{
  "type": "TaskCreated",
  "taskId": "task_abc123",
  "occurredAt": "2026-08-31T12:00:00.000Z",
  "version": 2,
  "payload": {
    "prompt": "Analyze Stellar DEX liquidity trends",
    "walletPublicKey": "GBZXN7...AAA",
    "dagSize": 3,
    "agentId": "agent-001",
    "durationMs": 42100,
  },
}
```

---

### 3.2 NodeStarted

Emitted when a DAG node begins execution.

#### Version 1

```jsonc
{
  "type": "NodeStarted",
  "taskId": "task_abc123",
  "nodeId": "node_research_1",
  "occurredAt": "2026-08-31T12:00:01.000Z",
  "version": 1,
  "payload": {
    "agentType": "research",
  },
}
```

#### Version 2 (current)

Adds optional `timeoutMs` field.

```jsonc
{
  "type": "NodeStarted",
  "taskId": "task_abc123",
  "nodeId": "node_research_1",
  "occurredAt": "2026-08-31T12:00:01.000Z",
  "version": 2,
  "payload": {
    "agentType": "research",
    "timeoutMs": 30000,
  },
}
```

---

### 3.3 NodeCompleted

Emitted when a DAG node completes successfully.

#### Version 1

```jsonc
{
  "type": "NodeCompleted",
  "taskId": "task_abc123",
  "nodeId": "node_research_1",
  "occurredAt": "2026-08-31T12:00:15.000Z",
  "version": 1,
  "payload": {
    "result": { "summary": "Liquidity increased by 14%", "sources": 5 },
  },
}
```

#### Version 2 (current)

Adds optional `durationMs` field.

```jsonc
{
  "type": "NodeCompleted",
  "taskId": "task_abc123",
  "nodeId": "node_research_1",
  "occurredAt": "2026-08-31T12:00:15.000Z",
  "version": 2,
  "payload": {
    "result": { "summary": "Liquidity increased by 14%", "sources": 5 },
    "durationMs": 14000,
  },
}
```

---

### 3.4 NodeFailed

Emitted when a DAG node fails after exhausting retries.

#### Version 1

```jsonc
{
  "type": "NodeFailed",
  "taskId": "task_abc123",
  "nodeId": "node_risk_1",
  "occurredAt": "2026-08-31T12:01:00.000Z",
  "version": 1,
  "payload": {
    "error": "Agent timeout after 30s",
  },
}
```

#### Version 2 (current)

Adds optional `retryCount` field.

```jsonc
{
  "type": "NodeFailed",
  "taskId": "task_abc123",
  "nodeId": "node_risk_1",
  "occurredAt": "2026-08-31T12:01:00.000Z",
  "version": 2,
  "payload": {
    "error": "Agent timeout after 30s",
    "retryCount": 3,
  },
}
```

---

### 3.5 PaymentLocked

Emitted when XLM is locked in escrow for an agent.

#### Version 1

```jsonc
{
  "type": "PaymentLocked",
  "taskId": "task_abc123",
  "nodeId": "node_research_1",
  "occurredAt": "2026-08-31T12:00:02.000Z",
  "version": 1,
  "payload": {
    "balanceId": "000000...",
    "amountStroops": 50000000,
  },
}
```

#### Version 2 (current)

Adds optional `xlmAmount` field.

```jsonc
{
  "type": "PaymentLocked",
  "taskId": "task_abc123",
  "nodeId": "node_research_1",
  "occurredAt": "2026-08-31T12:00:02.000Z",
  "version": 2,
  "payload": {
    "balanceId": "000000...",
    "amountStroops": 50000000,
    "xlmAmount": 5.0,
  },
}
```

---

### 3.6 PaymentReleased

Emitted when escrowed funds are released to the agent.

#### Version 1

```jsonc
{
  "type": "PaymentReleased",
  "taskId": "task_abc123",
  "nodeId": "node_research_1",
  "occurredAt": "2026-08-31T12:00:16.000Z",
  "version": 1,
  "payload": {
    "txHash": "d8e3b4a2c1f9e8d7...",
  },
}
```

#### Version 2 (current)

Adds optional `ledgerSequence` field.

```jsonc
{
  "type": "PaymentReleased",
  "taskId": "task_abc123",
  "nodeId": "node_research_1",
  "occurredAt": "2026-08-31T12:00:16.000Z",
  "version": 2,
  "payload": {
    "txHash": "d8e3b4a2c1f9e8d7...",
    "ledgerSequence": 5241098,
  },
}
```

---

### 3.7 TaskCompleted

Emitted when all DAG nodes complete successfully.

#### Version 1

```jsonc
{
  "type": "TaskCompleted",
  "taskId": "task_abc123",
  "occurredAt": "2026-08-31T12:01:30.000Z",
  "version": 1,
}
```

#### Version 2 (current)

Adds optional `durationMs` field.

```jsonc
{
  "type": "TaskCompleted",
  "taskId": "task_abc123",
  "occurredAt": "2026-08-31T12:01:30.000Z",
  "version": 2,
  "payload": {
    "durationMs": 90000,
  },
}
```

---

### 3.8 TaskFailed

Emitted when a task fails (all retries exhausted or a non-recoverable error).

#### Version 1

```jsonc
{
  "type": "TaskFailed",
  "taskId": "task_abc123",
  "occurredAt": "2026-08-31T12:01:30.000Z",
  "version": 1,
  "payload": {
    "error": "All agent dispatches failed",
  },
}
```

#### Version 2 (current)

Adds optional `failedStage` field.

```jsonc
{
  "type": "TaskFailed",
  "taskId": "task_abc123",
  "occurredAt": "2026-08-31T12:01:30.000Z",
  "version": 2,
  "payload": {
    "error": "All agent dispatches failed",
    "failedStage": "dispatch",
  },
}
```

---

### 3.9 ReconciliationEvent

Exported as `RECONCILIATION_EVENT` from `backend/src/events/eventTypes.ts`.

Emitted by the payment reconciliation service (issue #496) — **twice** for every
divergence between the local `payments` table and Stellar chain state: once when
the drift is detected (`payload.kind: "drift"`) and once when it is remediated
(`payload.kind: "remediation"`). Consumers that only want "something changed"
can subscribe to both and key off `payload.driftType`.

| `driftType`           | Meaning                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| `orphaned_locked`     | DB says `locked`, no on-chain claimable balance exists                      |
| `missing_release_tx`  | DB says `released`, the release transaction is absent from Horizon          |
| `release_unconfirmed` | DB says `released`, the claimable balance is still claimable                |
| `expired_escrow`      | Task reached a terminal unsuccessful state while the escrow is still locked |
| `missing_local`       | On-chain claimable balance has no local payment record                      |
| `amount_mismatch`     | On-chain and recorded amounts disagree                                      |

The payload shape is identical in v1 and v2 — the event was introduced alongside
schema v2 and every optional field simply defaults to absent.

```jsonc
// Drift detected
{
  "type": "ReconciliationEvent",
  "taskId": "task_abc123",
  "occurredAt": "2026-09-01T12:00:00.000Z",
  "version": 2,
  "payload": {
    "runId": "0f3c1c9e-2a51-4d1a-9f4e-0d2b1f2a3c4d",
    "kind": "drift",
    "driftType": "expired_escrow",
    "balanceId": "00000000abc123...",
    "taskId": "task_abc123",
    "nodeId": "node_risk",
    "severity": "warning",
    "description": "Escrow for task=task_abc123, node=node_risk is still locked on-chain (...)",
  },
}
```

```jsonc
// Drift remediated
{
  "type": "ReconciliationEvent",
  "taskId": "task_abc123",
  "occurredAt": "2026-09-01T12:00:01.000Z",
  "version": 2,
  "payload": {
    "runId": "0f3c1c9e-2a51-4d1a-9f4e-0d2b1f2a3c4d",
    "kind": "remediation",
    "driftType": "expired_escrow",
    "balanceId": "00000000abc123...",
    "taskId": "task_abc123",
    "nodeId": "node_risk",
    "severity": "warning",
    "description": "Escrow for task=task_abc123, node=node_risk is still locked on-chain (...)",
    "remediation": {
      "action": "refund_escrow",
      "status": "remediated",
      "txHash": "9f2c...",
      "at": "2026-09-01T12:00:01.000Z",
    },
    "previousStatus": "locked",
    "newStatus": "refunded",
  },
}
```

`remediation.action` is one of `mark_orphaned`, `backfill_tx_hash`,
`requeue_release`, `refund_escrow` or `manual_review`; `remediation.status` is one
of `remediated`, `skipped`, `failed` or `manual_review`. A remediation event is
only emitted when the action actually succeeded — a drift that was merely
_reported_ has `kind: "drift"` and no `remediation` block.

---

## 4. Version Migration Guide for Consumers

### 4.1 Reading events

Consumers **must** check the `version` field before accessing version-specific
fields:

```typescript
function handleTaskCreated(event: TaskCreatedEvent): void {
  console.log(event.payload.prompt);

  // v2+ fields are optional — always guard with a version check
  if (event.version >= 2 && event.payload.agentId) {
    console.log(`Dispatched to agent: ${event.payload.agentId}`);
  }
}
```

### 4.2 Unknown fields

The schema is append-only within a major version. New optional fields may
appear without a version bump. Consumers **must tolerate** unknown fields:

```typescript
// ✅ Safe — unknown fields are ignored
const { prompt, walletPublicKey } = event.payload;

// ❌ Unsafe — will break if new fields are added
const payload = event.payload as Exact<TaskCreatedPayload>;
```

### 4.3 Version downgrade

Consumers should not receive events with a version higher than the current
schema. If this happens (e.g. during a rolling upgrade), consumers should:

1. Log a warning.
2. Attempt to process the event using the latest known schema.
3. Skip fields they don't recognize.

### 4.4 Migration from v1 to v2

Version 2 adds **only optional fields** — no v1 fields are removed, renamed,
or retyped. Therefore:

- V1 events are valid v2 events (v1 fields are a subset of v2 fields).
- No data transformation is needed.
- Consumers can process v1 and v2 events with the same handler.

---

## 5. Adding a New Version

When a breaking change is required:

1. **Bump `CURRENT_EVENT_VERSION`** in `backend/src/events/eventTypes.ts`.
2. **Add Zod schemas** for the new version in `backend/src/events/schemaRegistry.ts`.
3. **Add migration logic** in `migrateEvent()` in the schema registry.
4. **Update payload interfaces** in `eventTypes.ts` with new fields (marked `/** vN: ... */`).
5. **Update this document** (`docs/EVENTS.md`) with examples for the new version.
6. **Run `bun convex dev --once`** (if applicable) and `bun tsc -b --noEmit` to verify.
7. **Add tests** in `backend/tests/eventSchemaRegistry.test.ts`.

---

## 6. On-Chain Event Versioning (Soroban Smart Contracts)

### Workspace contract event convention

All Soroban event topics use lowercase `snake_case` names. The first topic is
the contract namespace and the second is the action (`bid_submitted`, not
`BidSubmitted` or `bidSubmitted`). Payload fields are ordered from identity to
business values to time: IDs are addresses or strings, monetary values are
`i128`, and timestamps are `u64`. New events should include a stable `meta`
object when the payload is extended, containing the schema `version`, emitting
contract, and ledger timestamp.

`npm run events:check` scans every Rust contract event publication and rejects
topic names that do not follow this convention. Backend event records retain
their existing versioned envelope; on-chain payloads use the convention above
and are documented alongside their contract.

The Soroban smart contracts (`task_store`, `agent_registry`) maintain their
own event versioning via the `version: u32` field in contract event payloads.
These are separate from the backend event-sourcing versions but follow the
same compatibility rules:

- **Append-only**: Adding new fields does not require a version bump.
- **Breaking changes bump version**: Consumers branch on `version`.
- **Topic pairs are stable**: A breaking change bumps `version`, not the topic.

See `smart-contracts/docs/TASK_STORE_EVENTS.md` and
`smart-contracts/docs/events.md` for contract-specific details.
