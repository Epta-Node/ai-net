# Task Store Contract — Lifecycle Events

This document details the Soroban events emitted by the `task_store` smart
contract. These events give off-chain indexers and the UI a consistent,
versioned signal for every task lifecycle transition, without needing to
poll `get_task`/`get_task_status`/`get_task_lifecycle_status`.

## Event topics

The first topic names the event family, the second names the stage within it.
A task is created through exactly one of two entrypoints, and the family in the
topic tells you which:

| Topic 1 | Emitted by | Stages (topic 2) |
|---|---|---|
| `task_meta` | `store_task_metadata`, `update_task_status` (DAG tasks) | `created`, `updated`, `finalized` |
| `task_life` | `create_task`, `update_status` (budget tasks) | `created`, `status` |
| `task_str` | `set_coordinator` (admin) | `coord_set` |

The two families are deliberately separate. A DAG task carries an execution
graph and a pre-assigned agent list; a budget task carries only a creator, a
prompt hash and a budget. An indexer can therefore pick the family it cares
about without decoding the other.

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

## TaskStatus

Statuses are encoded as a `u32` in every payload above. The discriminants are
part of the public interface:

| Status | Value | Terminal |
|---|---|---|
| `Created` | 0 | no |
| `Queued` | 1 | no |
| `Assigned` | 2 | no |
| `Running` | 3 | no |
| `Completed` | 4 | **yes** |
| `Failed` | 5 | **yes** |
| `Cancelled` | 6 | **yes** |

The legal transitions are:

| From | To |
|---|---|
| `Created` | `Queued`, `Assigned`, `Cancelled`, `Failed` |
| `Queued` | `Assigned`, `Running`, `Cancelled`, `Failed` |
| `Assigned` | `Running`, `Cancelled`, `Failed` |
| `Running` | `Completed`, `Failed`, `Cancelled` |
| any terminal status | *(none)* |

Anything not in the table is rejected with `InvalidStatusTransition`, including
moving backwards and leaving a terminal status. A task therefore cannot be
resurrected once it has finished.

## Invariant: exactly one event per transition

Every successful creation emits exactly one event, and every successful status
change emits exactly one event — never both, and never zero. A call that is
rejected (unauthorized updater, invalid transition, expired task, paused
contract) emits no lifecycle event at all, since it errors out before any state
change or publish. This makes the event stream a complete record of state
changes: a missing event means a failed transaction, and nothing else.

## Recovering `tx_hash`

A Soroban contract cannot read the hash of the transaction that invoked it, so
no event and no history record carries one. Index the events by ledger
position and join them against transaction results off-chain: since each
accepted transition emits exactly one event, the join is unambiguous.

---

## `task_meta` family — DAG tasks

### 1. Task Created

Emitted once, when `store_task_metadata` succeeds. The task starts at
`Assigned`, because the creating transaction already names its agents.

- **Topics**: `(task_meta, created)`
- **Data**: `TaskCreatedEvent`
  ```rust
  pub struct TaskCreatedEvent {
      pub version: u32,
      pub task_id: BytesN<32>,
      pub prompt_hash: BytesN<32>,
      pub assigned_agents: Vec<Address>,
      pub created_at: u64,
      pub expires_at: u64,
      pub quoted_price_stroops: Option<i128>,
  }
  ```

### 2. Task Updated

Emitted when `update_task_status` succeeds with a **non-terminal** transition,
e.g. `Assigned -> Running`.

- **Topics**: `(task_meta, updated)`
- **Data**: `TaskUpdatedEvent`
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

Emitted when `update_task_status` succeeds with a transition **into a terminal
status** — `-> Completed`, `-> Failed` or `-> Cancelled`. `final_status` is
always one of those three; `old_status` records what it transitioned from.

- **Topics**: `(task_meta, finalized)`
- **Data**: `TaskFinalizedEvent`
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

| Transition | Event |
|---|---|
| (none) → `store_task_metadata` succeeds | `created` |
| `Assigned` → `Running` | `updated` |
| `Assigned` → `Cancelled` / `Failed` | `finalized` |
| `Running` → `Completed` / `Failed` / `Cancelled` | `finalized` |
| Any other transition (rejected — `InvalidStatusTransition`) | *(no event)* |

## `task_life` family — budget tasks

### 4. Budget Task Created

Emitted once, when `create_task` succeeds. The task starts at `Created`.

- **Topics**: `(task_life, created)`
- **Data**: `LifecycleTaskCreatedEvent`
  ```rust
  pub struct LifecycleTaskCreatedEvent {
      pub version: u32,
      pub task_id: BytesN<32>,
      pub creator: Address,
      pub prompt_hash: BytesN<32>,
      /// Budget committed by the creator, in stroops.
      pub budget_xlm: i128,
      pub created_at: u64,
  }
  ```

### 5. Budget Task Status Changed

Emitted for **every** accepted `update_status` transition. Note that this
family does not split terminal from non-terminal: a terminal transition is
distinguishable by `to_status.is_terminal()`, which keeps the event count at
exactly one per transition without the caller having to know the state machine.

- **Topics**: `(task_life, status)`
- **Data**: `LifecycleStatusChangedEvent`
  ```rust
  pub struct LifecycleStatusChangedEvent {
      pub version: u32,
      pub task_id: BytesN<32>,
      /// Version number of the history record this transition appended.
      pub record_version: u32,
      pub from_status: TaskStatus,
      pub to_status: TaskStatus,
      /// Creator for the creator-driven case, coordinator for the delegated one.
      pub updater: Address,
      pub updated_at: u64,
  }
  ```

`record_version` matches the `version` field of the task record and the `seq`
of the appended `TaskVersionRecord`, so an indexer can order the event stream
and the on-chain history against each other and detect any gap.

## `task_str` family — administration

### 6. Coordinator Set

Emitted when the admin calls `set_coordinator`. `coordinator: None` means the
coordinator was cleared, which revokes its authority to move tasks.

- **Topics**: `(task_str, coord_set)`
- **Data**: `CoordinatorSetEvent`
  ```rust
  pub struct CoordinatorSetEvent {
      pub coordinator: Option<Address>,
  }
  ```

## The version history

Both families append to one append-only history per task id, readable with
`get_history(task_id)` or bundled with the record by `get_task(task_id)`:

```rust
pub struct TaskVersionRecord {
    pub seq: u32,              // 1-based, one per accepted transition
    pub status: TaskStatus,
    pub timestamp: u64,
    pub ledger_sequence: u32,
    pub updater: Address,      // creator/submitter for seq 1, then the actor
}
```

Because the history is keyed by task id alone, it serves tasks created through
either entrypoint, and the DAG and budget records for one id keep separate
storage slots so neither can overwrite the other.

## Reading events with the JS/TS SDK

The TypeScript SDK (`smart-contracts/src/task_store/task_store.ts`) mirrors
this schema and exports `TaskStatus`, `canTransition` and `isTerminalStatus` so
off-chain code can validate a stream without re-deriving the state machine.
Filter by topic pair before decoding, e.g.:

```ts
if (topics[0] === "task_meta" && topics[1] === "finalized") {
  const event = scValToNative(data) as TaskFinalizedEvent;
  // event.version, event.final_status, ...
}

if (topics[0] === "task_life" && topics[1] === "status") {
  const event = scValToNative(data) as LifecycleStatusChangedEvent;
  if (isTerminalStatus(event.toStatus)) {
    // the task is finished; no further status events will arrive
  }
}
```
