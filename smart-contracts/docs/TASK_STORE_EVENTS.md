# Task Store Contract — Lifecycle Events

This document details the Soroban events emitted by the `task_store` smart
contract. These events give off-chain indexers and the UI a consistent,
versioned signal for every task lifecycle transition, without needing to
poll `get_task_metadata`/`get_task_status`.

## Event Topics

All task lifecycle events share the first topic (`task_meta`). The second
topic indicates which lifecycle stage occurred: `created`, `updated`, or
`finalized`.

## Versioning & Compatibility

Every payload carries a `version: u32` field (currently `1`, the
`TASK_LIFECYCLE_EVENT_VERSION` constant in
`contracts/task_store/src/types.rs`). The schema is **append-only**:

- Adding a new field to an existing payload does **not** require a version
  bump — consumers should tolerate unknown/new fields.
- Removing, renaming, or changing the type/meaning of an existing field
  **does** require a version bump, so existing consumers can detect the
  change (by branching on `version`) instead of silently misreading data.
- The topic pair for a given lifecycle stage (e.g. `(task_meta, created)`)
  is stable; a schema-breaking change bumps `version` in the payload, it
  does not introduce a new topic.

## Invariant: exactly one event per transition

Every successful call to `store_task_metadata` emits exactly one `created`
event. Every successful call to `update_task_status` emits exactly one
event — `updated` for a non-terminal transition, or `finalized` for a
transition into a terminal status — never both, and never zero. A call
that is rejected (unauthorized agent, invalid transition, expired task)
emits no lifecycle event at all, since it errors out before any state
change or publish.

---

### 1. Task Created

Emitted once, when `store_task_metadata` succeeds.

- **Topic 1**: `Symbol::new(env, "task_meta")`
- **Topic 2**: `Symbol::new(env, "created")`
- **Data (Structure)**: `TaskCreatedEvent`
  ```rust
  pub struct TaskCreatedEvent {
      pub version: u32,
      pub task_id: BytesN<32>,
      pub prompt_hash: BytesN<32>,
      pub assigned_agents: Vec<Address>,
      pub created_at: u64,
      pub expires_at: u64,
  }
  ```

### 2. Task Updated

Emitted when `update_task_status` succeeds with a **non-terminal**
transition. Today the only non-terminal transition is `Pending -> Running`;
`Pending -> Failed` is terminal and emits `finalized` instead (see below).

- **Topic 1**: `Symbol::new(env, "task_meta")`
- **Topic 2**: `Symbol::new(env, "updated")`
- **Data (Structure)**: `TaskUpdatedEvent`
  ```rust
  pub struct TaskUpdatedEvent {
      pub version: u32,
      pub task_id: BytesN<32>,
      pub agent: Address,
      pub old_status: TaskStatus,
      pub new_status: TaskStatus,
      pub updated_at: u64,
  }
  ```

### 3. Task Finalized

Emitted when `update_task_status` succeeds with a transition **into a
terminal status** — `-> Completed` or `-> Failed`. `final_status` is
always one of those two values; `old_status` records what it transitioned
from.

- **Topic 1**: `Symbol::new(env, "task_meta")`
- **Topic 2**: `Symbol::new(env, "finalized")`
- **Data (Structure)**: `TaskFinalizedEvent`
  ```rust
  pub struct TaskFinalizedEvent {
      pub version: u32,
      pub task_id: BytesN<32>,
      pub agent: Address,
      pub old_status: TaskStatus,
      pub final_status: TaskStatus,
      pub finalized_at: u64,
  }
  ```

## Status transition → event map

| Transition | Event |
|---|---|
| (none) → `store_task_metadata` succeeds | `created` |
| `Pending` → `Running` | `updated` |
| `Running` → `Completed` | `finalized` |
| `Pending` → `Failed` | `finalized` |
| `Running` → `Failed` | `finalized` |
| Any other transition (rejected — `InvalidStatusTransition`) | *(no event)* |

## Reading events with the JS/TS SDK

The contract's generated bindings (`smart-contracts/src/`) expose the
event payload types once regenerated from the built Wasm. Off-chain code
should filter by topic pair before decoding, e.g.:

```ts
if (topics[0] === "task_meta" && topics[1] === "finalized") {
  const event = scValToNative(data) as TaskFinalizedEvent;
  // event.version, event.final_status, ...
}
```
