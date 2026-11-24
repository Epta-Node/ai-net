import {
  ALLOWED_TASK_TRANSITIONS,
  canTransition,
  isTerminalStatus,
  taskStatusName,
  TERMINAL_TASK_STATUSES,
  TaskRecord,
  TaskStatus,
  TaskStoreContractClient,
  TaskStoreSDK,
  TaskVersionRecord,
  TaskWithHistory,
} from '../src/task_store/task_store';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const ADMIN = 'GADMIN';
const CREATOR = 'GCREATOR';
const COORDINATOR = 'GCOORDINATOR';
const AGENT = 'GAGENT1';

const taskId = () => new Uint8Array(32).fill(7);
const promptHash = () => new Uint8Array(32).fill(9);

function sent(): { signAndSend: jest.Mock; simulate: jest.Mock } {
  return { signAndSend: jest.fn().mockResolvedValue(undefined), simulate: jest.fn() };
}

function makeClient(): TaskStoreContractClient {
  return {
    initialize: jest.fn(() => sent()),
    store_task_metadata: jest.fn(() => sent()),
    get_task_metadata: jest.fn(() => sent()),
    get_task_status: jest.fn(() => sent()),
    update_task_status: jest.fn(() => sent()),
    create_task: jest.fn(() => sent()),
    update_status: jest.fn(() => sent()),
    get_task: jest.fn(() => sent()),
    get_task_lifecycle_status: jest.fn(() => sent()),
    get_history: jest.fn(() => sent()),
    get_task_creator: jest.fn(() => sent()),
    get_tasks_by_creator: jest.fn(() => sent()),
    set_coordinator: jest.fn(() => sent()),
    get_coordinator: jest.fn(() => sent()),
    set_oracle_manager: jest.fn(() => sent()),
    pause: jest.fn(() => sent()),
    unpause: jest.fn(() => sent()),
    is_paused: jest.fn(() => sent()),
  } as unknown as TaskStoreContractClient;
}

// ── The state machine is part of the SDK contract ──────────────────────────────

describe('TaskStatus', () => {
  it('uses the on-chain discriminants', () => {
    expect(TaskStatus.Created).toBe(0);
    expect(TaskStatus.Queued).toBe(1);
    expect(TaskStatus.Assigned).toBe(2);
    expect(TaskStatus.Running).toBe(3);
    expect(TaskStatus.Completed).toBe(4);
    expect(TaskStatus.Failed).toBe(5);
    expect(TaskStatus.Cancelled).toBe(6);
  });

  it('names every status it knows and admits the ones it does not', () => {
    expect(taskStatusName(TaskStatus.Queued)).toBe('Queued');
    expect(taskStatusName(99 as TaskStatus)).toBe('Unknown(99)');
  });

  it('treats completed, failed and cancelled as terminal', () => {
    expect([...TERMINAL_TASK_STATUSES]).toEqual([
      TaskStatus.Completed,
      TaskStatus.Failed,
      TaskStatus.Cancelled,
    ]);
    expect(isTerminalStatus(TaskStatus.Completed)).toBe(true);
    expect(isTerminalStatus(TaskStatus.Failed)).toBe(true);
    expect(isTerminalStatus(TaskStatus.Cancelled)).toBe(true);
    expect(isTerminalStatus(TaskStatus.Running)).toBe(false);
  });
});

describe('canTransition', () => {
  it('allows a full happy path', () => {
    expect(canTransition(TaskStatus.Created, TaskStatus.Queued)).toBe(true);
    expect(canTransition(TaskStatus.Queued, TaskStatus.Assigned)).toBe(true);
    expect(canTransition(TaskStatus.Assigned, TaskStatus.Running)).toBe(true);
    expect(canTransition(TaskStatus.Running, TaskStatus.Completed)).toBe(true);
  });

  it('rejects skipping the queue when a task is assigned directly', () => {
    expect(canTransition(TaskStatus.Created, TaskStatus.Assigned)).toBe(true);
  });

  it('rejects running or completing a task that has not started', () => {
    expect(canTransition(TaskStatus.Created, TaskStatus.Running)).toBe(false);
    expect(canTransition(TaskStatus.Created, TaskStatus.Completed)).toBe(false);
    expect(canTransition(TaskStatus.Queued, TaskStatus.Completed)).toBe(false);
  });

  it('rejects leaving a terminal state in any direction', () => {
    const everyStatus = [
      TaskStatus.Created,
      TaskStatus.Queued,
      TaskStatus.Assigned,
      TaskStatus.Running,
      TaskStatus.Completed,
      TaskStatus.Failed,
      TaskStatus.Cancelled,
    ];
    for (const terminal of TERMINAL_TASK_STATUSES) {
      expect(ALLOWED_TASK_TRANSITIONS[terminal]).toBeUndefined();
      for (const target of everyStatus) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('rejects going backwards', () => {
    expect(canTransition(TaskStatus.Running, TaskStatus.Queued)).toBe(false);
    expect(canTransition(TaskStatus.Queued, TaskStatus.Created)).toBe(false);
  });

  it('lets an unfinished task be cancelled from any non-terminal state', () => {
    expect(canTransition(TaskStatus.Created, TaskStatus.Cancelled)).toBe(true);
    expect(canTransition(TaskStatus.Queued, TaskStatus.Cancelled)).toBe(true);
    expect(canTransition(TaskStatus.Assigned, TaskStatus.Cancelled)).toBe(true);
    expect(canTransition(TaskStatus.Running, TaskStatus.Cancelled)).toBe(true);
  });

  it('lets an unfinished task fail from any non-terminal state', () => {
    expect(canTransition(TaskStatus.Created, TaskStatus.Failed)).toBe(true);
    expect(canTransition(TaskStatus.Assigned, TaskStatus.Failed)).toBe(true);
    expect(canTransition(TaskStatus.Running, TaskStatus.Failed)).toBe(true);
    // A task that has not started cannot complete.
    expect(canTransition(TaskStatus.Assigned, TaskStatus.Completed)).toBe(false);
  });
});

// ── createTask / updateStatus / getTask ────────────────────────────────────────

describe('TaskStoreSDK budget tasks', () => {
  let client: TaskStoreContractClient;
  let sdk: TaskStoreSDK;

  beforeEach(() => {
    client = makeClient();
    sdk = new TaskStoreSDK(client);
  });

  it('passes the budget through in stroops', async () => {
    await sdk.createTask({
      taskId: taskId(),
      creator: CREATOR,
      promptHash: promptHash(),
      budgetXlm: 5_000_000n,
    });

    expect(client.create_task).toHaveBeenCalledWith({
      task_id: taskId(),
      creator: CREATOR,
      prompt_hash: promptHash(),
      budget_xlm: 5_000_000n,
    });
  });

  it('sends the updater with a status change', async () => {
    await sdk.updateStatus({
      taskId: taskId(),
      newStatus: TaskStatus.Queued,
      updater: COORDINATOR,
    });

    expect(client.update_status).toHaveBeenCalledWith({
      task_id: taskId(),
      new_status: TaskStatus.Queued,
      updater: COORDINATOR,
    });
  });

  it('returns the record together with its history', async () => {
    const task: TaskRecord = {
      taskId: taskId(),
      creator: CREATOR,
      promptHash: promptHash(),
      budgetXlm: 1_000n,
      status: TaskStatus.Running,
      createdAt: 100n,
      updatedAt: 200n,
      version: 4,
    };
    const history: TaskVersionRecord[] = [
      { seq: 1, status: TaskStatus.Created, timestamp: 100n, ledgerSequence: 1, updater: CREATOR },
      { seq: 2, status: TaskStatus.Queued, timestamp: 120n, ledgerSequence: 2, updater: COORDINATOR },
      { seq: 3, status: TaskStatus.Assigned, timestamp: 140n, ledgerSequence: 3, updater: COORDINATOR },
      { seq: 4, status: TaskStatus.Running, timestamp: 160n, ledgerSequence: 4, updater: COORDINATOR },
    ];
    const full: TaskWithHistory = { task, history };
    (client.get_task as jest.Mock).mockReturnValue({
      simulate: jest.fn().mockResolvedValue(full),
    });

    await expect(sdk.getTask(taskId())).resolves.toEqual(full);
  });

  it('reads the lifecycle status separately from the DAG status', async () => {
    (client.get_task_lifecycle_status as jest.Mock).mockReturnValue({
      simulate: jest.fn().mockResolvedValue(TaskStatus.Created),
    });

    await expect(sdk.getTaskLifecycleStatus(taskId())).resolves.toBe(TaskStatus.Created);
  });
});

// ── DAG tasks ──────────────────────────────────────────────────────────────────

describe('TaskStoreSDK DAG tasks', () => {
  let client: TaskStoreContractClient;
  let sdk: TaskStoreSDK;

  beforeEach(() => {
    client = makeClient();
    sdk = new TaskStoreSDK(client);
  });

  it('defaults the TTL to zero so the contract applies its own', async () => {
    await sdk.storeTask({
      submitter: CREATOR,
      taskId: taskId(),
      promptHash: promptHash(),
      assignedAgents: [AGENT],
      compressedDag: new Uint8Array([1, 2, 3]),
    });

    expect(client.store_task_metadata).toHaveBeenCalledWith({
      submitter: CREATOR,
      task_id: taskId(),
      prompt_hash: promptHash(),
      assigned_agents: [AGENT],
      compressed_dag: new Uint8Array([1, 2, 3]),
      ttl_days: 0,
      price_pair: undefined,
    });
  });

  it('forwards the price pair for oracle resolution', async () => {
    await sdk.storeTask({
      submitter: CREATOR,
      taskId: taskId(),
      promptHash: promptHash(),
      assignedAgents: [AGENT],
      compressedDag: new Uint8Array([1]),
      ttlDays: 7,
      pricePair: 'XLM/USDC',
    });

    expect((client.store_task_metadata as jest.Mock).mock.calls[0][0]).toMatchObject({
      ttl_days: 7,
      price_pair: 'XLM/USDC',
    });
  });

  it('sends the agent as the status updater', async () => {
    await sdk.updateTaskStatus({
      taskId: taskId(),
      updater: AGENT,
      newStatus: TaskStatus.Completed,
    });

    expect(client.update_task_status).toHaveBeenCalledWith({
      task_id: taskId(),
      agent: AGENT,
      new_status: TaskStatus.Completed,
    });
  });

  it('reads DAG metadata by id', async () => {
    (client.get_task_metadata as jest.Mock).mockReturnValue({
      simulate: jest.fn().mockResolvedValue({ status: TaskStatus.Assigned }),
    });

    const metadata = await sdk.getTaskMetadata(taskId());
    expect(metadata.status).toBe(TaskStatus.Assigned);
  });
});

// ── The shared audit trail ─────────────────────────────────────────────────────

describe('TaskStoreSDK history', () => {
  let client: TaskStoreContractClient;
  let sdk: TaskStoreSDK;

  beforeEach(() => {
    client = makeClient();
    sdk = new TaskStoreSDK(client);
  });

  it('returns the history oldest-first', async () => {
    const history: TaskVersionRecord[] = [
      { seq: 1, status: TaskStatus.Assigned, timestamp: 1n, ledgerSequence: 10, updater: CREATOR },
      { seq: 2, status: TaskStatus.Running, timestamp: 2n, ledgerSequence: 11, updater: AGENT },
    ];
    (client.get_history as jest.Mock).mockReturnValue({
      simulate: jest.fn().mockResolvedValue(history),
    });

    const result = await sdk.getHistory(taskId());
    expect(result.map((record) => record.status)).toEqual([
      TaskStatus.Assigned,
      TaskStatus.Running,
    ]);
    // No transaction hash is claimed: the contract cannot observe it.
    for (const record of result) {
      expect(record).not.toHaveProperty('txHash');
    }
  });

  it('paginates a creator index from the first page', async () => {
    (client.get_tasks_by_creator as jest.Mock).mockReturnValue({
      simulate: jest.fn().mockResolvedValue({
        taskIds: [new Uint8Array(32).fill(1)],
        total: 3,
        nextCursor: 1,
      }),
    });

    const page = await sdk.getTasksByCreator(CREATOR);
    expect(client.get_tasks_by_creator).toHaveBeenCalledWith({
      creator: CREATOR,
      cursor: 0,
      limit: 20,
    });
    expect(page.nextCursor).toBe(1);
  });
});

// ── Administration ─────────────────────────────────────────────────────────────

describe('TaskStoreSDK administration', () => {
  let client: TaskStoreContractClient;
  let sdk: TaskStoreSDK;

  beforeEach(() => {
    client = makeClient();
    sdk = new TaskStoreSDK(client);
  });

  it('sets and clears the coordinator', async () => {
    await sdk.setCoordinator(COORDINATOR);
    expect(client.set_coordinator).toHaveBeenCalledWith({ coordinator: COORDINATOR });

    await sdk.setCoordinator(null);
    expect(client.set_coordinator).toHaveBeenLastCalledWith({ coordinator: null });
  });

  it('reads the coordinator', async () => {
    (client.get_coordinator as jest.Mock).mockReturnValue({
      simulate: jest.fn().mockResolvedValue(COORDINATOR),
    });

    await expect(sdk.getCoordinator()).resolves.toBe(COORDINATOR);
  });

  it('sets the oracle manager without an admin argument', async () => {
    await sdk.setOracleManager('GORACLE');
    expect(client.set_oracle_manager).toHaveBeenCalledWith({ oracle_manager: 'GORACLE' });
  });

  it('pauses, unpauses and reports the paused state', async () => {
    (client.is_paused as jest.Mock).mockReturnValue({
      simulate: jest.fn().mockResolvedValue(true),
    });

    await sdk.pause();
    await sdk.unpause();
    expect(client.pause).toHaveBeenCalled();
    expect(client.unpause).toHaveBeenCalled();
    await expect(sdk.isPaused()).resolves.toBe(true);
  });
});
