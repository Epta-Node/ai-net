/**
 * TypeScript SDK wrapper for the Task Store Soroban contract.
 *
 * Provides a typed client interface for the on-chain task store, which holds two
 * kinds of task and an append-only audit trail for both:
 *
 *  - **DAG tasks** — `store_task_metadata` records a full execution graph with a
 *    pre-assigned agent list, and starts at {@link TaskStatus.Assigned}.
 *  - **Budget tasks** — `create_task` records only a creator, a prompt hash and a
 *    budget, and starts at {@link TaskStatus.Created}.
 *
 * Every accepted status change appends a {@link TaskVersionRecord}, so the
 * complete history of a task can be reconstructed from the chain alone.
 *
 * Key operations:
 *  - `storeTask`            – create a DAG task, optionally resolving a price
 *  - `createTask`           – create a budget-based task
 *  - `updateTaskStatus`     – advance a DAG task (assigned agent, creator or coordinator)
 *  - `updateStatus`         – advance a budget task (creator or coordinator)
 *  - `getTask`              – fetch a budget task with its full history (read-only)
 *  - `getTaskStatus`        – fetch a DAG task's status (read-only)
 *  - `getTaskLifecycleStatus` – fetch a budget task's status (read-only)
 *  - `getHistory`           – fetch the append-only version history (read-only)
 *  - `getTaskCreator`       – fetch the address that created a task (read-only)
 *  - `getTasksByCreator`    – paginated list of a creator's task ids (read-only)
 *  - `setCoordinator`       – configure the coordinator allowed to move tasks
 *  - `setOracleManager`     – configure the oracle manager for price resolution
 *
 * Mirrors the Rust contract interface in contracts/task_store/src/lib.rs.
 *
 * Issue #490 — TypeScript SDK wrappers for all Soroban contracts
 */

// ---------------------------------------------------------------------------
// Shared transaction wrapper (mirrors coordinator.ts pattern)
// ---------------------------------------------------------------------------

/** Thin wrapper around an assembled Soroban transaction. */
export interface AssembledTransaction<T> {
  signAndSend(): Promise<T>;
  simulate(): Promise<T>;
}

// ---------------------------------------------------------------------------
// Domain types (mirrors task_store/src/types.rs)
// ---------------------------------------------------------------------------

/**
 * Task lifecycle states.
 *
 * The numeric values are the on-chain discriminants and must match
 * `TaskStatus` in contracts/task_store/src/types.rs exactly — a task's status is
 * encoded in its history and in `task_life` / `task_meta` events, so these
 * numbers are part of the contract's public interface.
 */
export enum TaskStatus {
  /** Created, no queue or agent yet. Budget tasks start here. */
  Created = 0,
  /** Accepted and waiting for an agent to pick the task up. */
  Queued = 1,
  /** An agent owns the task. DAG tasks start here. */
  Assigned = 2,
  /** An agent is executing the task. */
  Running = 3,
  /** Terminal: finished successfully. */
  Completed = 4,
  /** Terminal: finished unsuccessfully. */
  Failed = 5,
  /** Terminal: withdrawn before completion. */
  Cancelled = 6,
}

/** Statuses from which no further transition is allowed. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  TaskStatus.Completed,
  TaskStatus.Failed,
  TaskStatus.Cancelled,
];

/** Whether `status` is terminal, i.e. the task can no longer change. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/**
 * The legal transitions of the lifecycle state machine.
 *
 * A transition absent from this map is rejected on-chain with
 * `InvalidStatusTransition`, so this table is the single source of truth for
 * "can this task move to that state next?".
 */
export const ALLOWED_TASK_TRANSITIONS: Readonly<Partial<Record<TaskStatus, readonly TaskStatus[]>>> =
  {
    [TaskStatus.Created]: [TaskStatus.Queued, TaskStatus.Assigned, TaskStatus.Cancelled, TaskStatus.Failed],
    [TaskStatus.Queued]: [TaskStatus.Assigned, TaskStatus.Running, TaskStatus.Cancelled, TaskStatus.Failed],
    [TaskStatus.Assigned]: [TaskStatus.Running, TaskStatus.Cancelled, TaskStatus.Failed],
    [TaskStatus.Running]: [TaskStatus.Completed, TaskStatus.Failed, TaskStatus.Cancelled],
  };

/** Whether a task in `from` may legally move to `to`. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (ALLOWED_TASK_TRANSITIONS[from] ?? []).includes(to);
}

/** Human-readable name of a status, e.g. `'Running'`. */
export function taskStatusName(status: TaskStatus): string {
  return TaskStatus[status] ?? `Unknown(${status})`;
}

/** Metadata for a DAG task, as stored by `store_task_metadata`. */
export interface TaskMetadata {
  taskId: Uint8Array;
  submitter: string;
  promptHash: Uint8Array;
  assignedAgents: string[];
  /** DEFLATE-compressed DAG payload */
  compressedDag: Uint8Array;
  status: TaskStatus;
  createdAt: bigint;
  expiresAt: bigint;
  /** Price in stroops resolved via oracle at task creation time, if configured */
  quotedPriceStroops?: bigint;
}

/**
 * A budget-based task, as stored by `create_task`.
 *
 * Unlike {@link TaskMetadata} this carries no agent list and no DAG: the
 * coordinator drives it from `Created` through the lifecycle states.
 */
export interface TaskRecord {
  taskId: Uint8Array;
  creator: string;
  promptHash: Uint8Array;
  /**
   * Budget in stroops.
   *
   * The contract field is named `budget_xlm` but is denominated in stroops, so
   * 1 XLM is `10_000_000`. Zero is allowed; negative values are rejected.
   */
  budgetXlm: bigint;
  status: TaskStatus;
  createdAt: bigint;
  updatedAt: bigint;
  /** Number of accepted transitions so far; 1 means the task was just created. */
  version: number;
}

/** A task paired with its complete, ordered audit trail. */
export interface TaskWithHistory {
  task: TaskRecord;
  history: TaskVersionRecord[];
}

export interface StoreTaskInput {
  submitter: string;
  taskId: Uint8Array;
  promptHash: Uint8Array;
  assignedAgents: string[];
  compressedDag: Uint8Array;
  /** Time-to-live in days (0 = use contract default) */
  ttlDays?: number;
  /** Price pair for oracle resolution, e.g. "XLM/USDC" */
  pricePair?: string;
}

/**
 * One immutable entry in a task's version history.
 *
 * Records are append-only: `seq` starts at 1 for the record written at task
 * creation and increases by one per accepted status transition. Reading them in
 * order yields every status the task has ever held. Rejected transitions — an
 * illegal jump, an unauthorized updater, a paused contract — append nothing.
 *
 * There is deliberately no `txHash` field. A Soroban contract cannot read the
 * hash of the transaction that invoked it — the SDK exposes no host function for
 * that — so no value stored here could be contract-verified. Join these records
 * against the `task_meta` and `task_life` lifecycle events to recover the
 * `tx_hash` off-chain; each event is emitted by exactly one transition, so the
 * join is unambiguous.
 */
export interface TaskVersionRecord {
  /** Monotonic sequence number, 1-based. */
  seq: number;
  status: TaskStatus;
  /** Ledger timestamp of the transition. */
  timestamp: bigint;
  /** Ledger sequence number of the transition. */
  ledgerSequence: number;
  /** Creator for the creation record, then whoever authorized the transition. */
  updater: string;
}

/**
 * One page of a creator's task index.
 *
 * The on-chain index is a bounded persistent vector, so it is paginated rather
 * than returned whole. Start with `cursor: 0`, follow `nextCursor` until it is
 * `null`.
 */
export interface TaskPage {
  /** Task ids for this page, oldest first. */
  taskIds: Uint8Array[];
  /** Total number of task ids tracked for this creator, across all pages. */
  total: number;
  /** Cursor for the next page, or `null` on the final page. */
  nextCursor: number | null;
}

// ---------------------------------------------------------------------------
// Contract client interface
// ---------------------------------------------------------------------------

export interface TaskStoreContractClient {
  initialize(args: { admin: string }): AssembledTransaction<void>;

  // --- DAG tasks ---

  store_task_metadata(args: {
    submitter: string;
    task_id: Uint8Array;
    prompt_hash: Uint8Array;
    assigned_agents: string[];
    compressed_dag: Uint8Array;
    ttl_days: number;
    price_pair?: string;
  }): AssembledTransaction<void>;

  get_task_metadata(task_id: Uint8Array): AssembledTransaction<TaskMetadata>;

  get_task_status(task_id: Uint8Array): AssembledTransaction<TaskStatus>;

  update_task_status(args: {
    task_id: Uint8Array;
    agent: string;
    new_status: TaskStatus;
  }): AssembledTransaction<void>;

  // --- Budget tasks ---

  create_task(args: {
    task_id: Uint8Array;
    creator: string;
    prompt_hash: Uint8Array;
    budget_xlm: bigint;
  }): AssembledTransaction<void>;

  update_status(args: {
    task_id: Uint8Array;
    new_status: TaskStatus;
    updater: string;
  }): AssembledTransaction<void>;

  get_task(task_id: Uint8Array): AssembledTransaction<TaskWithHistory>;

  get_task_lifecycle_status(task_id: Uint8Array): AssembledTransaction<TaskStatus>;

  // --- Shared audit trail ---

  get_history(task_id: Uint8Array): AssembledTransaction<TaskVersionRecord[]>;

  get_task_creator(task_id: Uint8Array): AssembledTransaction<string | null>;

  get_tasks_by_creator(args: {
    creator: string;
    cursor: number;
    limit: number;
  }): AssembledTransaction<TaskPage>;

  // --- Administration ---

  set_coordinator(args: { coordinator: string | null }): AssembledTransaction<void>;

  get_coordinator(): AssembledTransaction<string | null>;

  set_oracle_manager(args: { oracle_manager: string | null }): AssembledTransaction<void>;

  pause(): AssembledTransaction<void>;

  unpause(): AssembledTransaction<void>;

  is_paused(): AssembledTransaction<boolean>;
}

// ---------------------------------------------------------------------------
// High-level SDK wrapper class
// ---------------------------------------------------------------------------

/**
 * TaskStoreSDK — high-level wrapper around the TaskStore Soroban contract.
 *
 * @example
 * ```ts
 * const sdk = new TaskStoreSDK(client);
 *
 * await sdk.storeTask({
 *   submitter: 'GSUB...',
 *   taskId: crypto.getRandomValues(new Uint8Array(32)),
 *   promptHash: sha256('my task prompt'),
 *   assignedAgents: ['GAGENT1...', 'GAGENT2...'],
 *   compressedDag: deflateSync(Buffer.from(JSON.stringify(dag))),
 *   ttlDays: 7,
 *   pricePair: 'XLM/USDC',
 * });
 * ```
 */
export class TaskStoreSDK {
  constructor(private readonly client: TaskStoreContractClient) {}

  /**
   * Initialise the contract with the given admin address.
   */
  async initialize(admin: string): Promise<void> {
    return this.client.initialize({ admin }).signAndSend();
  }

  // -------------------------------------------------------------------------
  // DAG tasks
  // -------------------------------------------------------------------------

  /**
   * Store DAG task metadata on-chain. If `pricePair` is provided and an oracle
   * manager is configured, the current market price is stamped immutably.
   *
   * The task starts at {@link TaskStatus.Assigned} because the submitting
   * transaction already names the agents that will run it.
   */
  async storeTask(input: StoreTaskInput): Promise<void> {
    return this.client
      .store_task_metadata({
        submitter: input.submitter,
        task_id: input.taskId,
        prompt_hash: input.promptHash,
        assigned_agents: input.assignedAgents,
        compressed_dag: input.compressedDag,
        ttl_days: input.ttlDays ?? 0,
        price_pair: input.pricePair,
      })
      .signAndSend();
  }

  /**
   * Fetch DAG task metadata by task ID (read-only).
   */
  async getTaskMetadata(taskId: Uint8Array): Promise<TaskMetadata> {
    return this.client.get_task_metadata(taskId).simulate();
  }

  /**
   * Fetch only a DAG task's status (read-only, cheaper simulation).
   */
  async getTaskStatus(taskId: Uint8Array): Promise<TaskStatus> {
    return this.client.get_task_status(taskId).simulate();
  }

  /**
   * Advance a DAG task in the lifecycle state machine.
   *
   * `updater` may be the task's creator or one of its assigned agents; the
   * contract rejects anyone else. Terminal tasks accept no further transitions.
   */
  async updateTaskStatus(args: {
    taskId: Uint8Array;
    updater: string;
    newStatus: TaskStatus;
  }): Promise<void> {
    return this.client
      .update_task_status({
        task_id: args.taskId,
        agent: args.updater,
        new_status: args.newStatus,
      })
      .signAndSend();
  }

  // -------------------------------------------------------------------------
  // Budget tasks
  // -------------------------------------------------------------------------

  /**
   * Create a budget-based task. The task starts at {@link TaskStatus.Created}
   * and is retained for the contract's default TTL, which cannot be overridden.
   *
   * @example
   * ```ts
   * await sdk.createTask({
   *   taskId,
   *   creator: 'GSUB...',
   *   promptHash,
   *   budgetXlm: 5_000_000n, // 5 XLM in stroops
   * });
   * ```
   */
  async createTask(args: {
    taskId: Uint8Array;
    creator: string;
    promptHash: Uint8Array;
    budgetXlm: bigint;
  }): Promise<void> {
    return this.client
      .create_task({
        task_id: args.taskId,
        creator: args.creator,
        prompt_hash: args.promptHash,
        budget_xlm: args.budgetXlm,
      })
      .signAndSend();
  }

  /**
   * Advance a budget task in the lifecycle state machine.
   *
   * `updater` must be the task's creator or the configured coordinator. Illegal
   * jumps and terminal re-entry are rejected without writing a version.
   */
  async updateStatus(args: {
    taskId: Uint8Array;
    newStatus: TaskStatus;
    updater: string;
  }): Promise<void> {
    return this.client
      .update_status({
        task_id: args.taskId,
        new_status: args.newStatus,
        updater: args.updater,
      })
      .signAndSend();
  }

  /**
   * Fetch a budget task together with its complete audit trail (read-only).
   */
  async getTask(taskId: Uint8Array): Promise<TaskWithHistory> {
    return this.client.get_task(taskId).simulate();
  }

  /**
   * Fetch only a budget task's status (read-only, cheaper simulation).
   */
  async getTaskLifecycleStatus(taskId: Uint8Array): Promise<TaskStatus> {
    return this.client.get_task_lifecycle_status(taskId).simulate();
  }

  // -------------------------------------------------------------------------
  // Shared audit trail
  // -------------------------------------------------------------------------

  /**
   * Fetch a task's append-only version history, oldest record first (read-only).
   *
   * Works for both task kinds. The first record is the one written at creation
   * (`Assigned` for a DAG task, `Created` for a budget task), attributed to the
   * submitter or creator; each accepted status change appends exactly one more.
   * Rejected transitions append nothing.
   *
   * Throws if the task is unknown or past its retention window.
   *
   * @example
   * ```ts
   * const history = await sdk.getHistory(taskId);
   * for (const record of history) {
   *   console.log(record.seq, taskStatusName(record.status), record.updater);
   * }
   * ```
   */
  async getHistory(taskId: Uint8Array): Promise<TaskVersionRecord[]> {
    return this.client.get_history(taskId).simulate();
  }

  /**
   * Fetch the address that created a task, or `null` if unknown (read-only).
   *
   * Works for both task kinds.
   */
  async getTaskCreator(taskId: Uint8Array): Promise<string | null> {
    return this.client.get_task_creator(taskId).simulate();
  }

  /**
   * Fetch one page of the task ids created by `creator`, oldest first.
   *
   * The on-chain index is bounded and paginated: pass `cursor: 0` to start, then
   * follow `nextCursor` until it is `null`. `limit` is clamped on-chain to
   * `MAX_TASKS_PAGE_SIZE` (20).
   *
   * @example
   * ```ts
   * let cursor = 0;
   * const all: Uint8Array[] = [];
   * do {
   *   const page = await sdk.getTasksByCreator('GCREATOR...', cursor, 20);
   *   all.push(...page.taskIds);
   *   cursor = page.nextCursor ?? -1;
   * } while (cursor >= 0);
   * ```
   */
  async getTasksByCreator(
    creator: string,
    cursor = 0,
    limit = 20,
  ): Promise<TaskPage> {
    return this.client
      .get_tasks_by_creator({ creator, cursor, limit })
      .simulate();
  }

  // -------------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------------

  /**
   * Configure the coordinator address permitted to move tasks on top of their
   * own actions, or pass `null` to revoke that authority (admin only).
   */
  async setCoordinator(coordinator: string | null): Promise<void> {
    return this.client.set_coordinator({ coordinator }).signAndSend();
  }

  /**
   * Fetch the configured coordinator, or `null` if none is set (read-only).
   */
  async getCoordinator(): Promise<string | null> {
    return this.client.get_coordinator().simulate();
  }

  /**
   * Configure the oracle manager contract address, or pass `null` to clear it
   * (admin only).
   */
  async setOracleManager(oracleManager: string | null): Promise<void> {
    return this.client.set_oracle_manager({ oracle_manager: oracleManager }).signAndSend();
  }

  /** Halt task creation and status changes (admin only). */
  async pause(): Promise<void> {
    return this.client.pause().signAndSend();
  }

  /** Resume task creation and status changes (admin only). */
  async unpause(): Promise<void> {
    return this.client.unpause().signAndSend();
  }

  /** Whether the contract is currently paused (read-only). */
  async isPaused(): Promise<boolean> {
    return this.client.is_paused().simulate();
  }
}

