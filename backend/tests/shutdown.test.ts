// Mock transitive dependencies before importing src/index to prevent side effects
jest.mock('../src/api/app', () => ({
  createApp: jest.fn(() => ({
    httpServer: {},
    close: jest.fn(),
  })),
}));

jest.mock('../src/agents', () => ({
  initializeAgents: jest.fn(),
  globalAgentRegistry: { shutdown: jest.fn() },
}));

jest.mock('../src/config', () => ({
  loadConfig: jest.fn(() => ({})),
  redactedConfigSnapshot: jest.fn(() => ({})),
  getConfig: jest.fn(() => ({})),
}));

jest.mock('../src/services/agentCleanup', () => ({
  AgentCleanupService: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}));

jest.mock('../src/services/reconciliation', () => ({
  createDefaultReconciliationService: jest.fn(() => ({
    startDaily: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock('../src/services/dbMaintenance', () => ({
  DbMaintenanceService: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
  defaultMaintenanceDatabases: jest.fn(() => []),
}));

jest.mock('../src/services/errorRegistryMaintenance', () => ({
  ErrorRegistryMaintenanceService: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}));

jest.mock('../src/services/idempotency', () => ({
  getDefaultIdempotencyStore: jest.fn(),
  resetDefaultIdempotencyStore: jest.fn(),
}));

jest.mock('../src/registry/sync', () => ({
  stopAgentSync: jest.fn(),
  startAgentSync: jest.fn(),
}));

jest.mock('../src/db', () => ({
  closeDb: jest.fn(),
}));

jest.mock('../src/db/agents', () => ({
  closeAgentDb: jest.fn(),
  getAgentDb: jest.fn(),
  createAgentDb: jest.fn(),
}));

jest.mock('../src/db/tasks', () => ({
  closeTaskDb: jest.fn(),
  getTaskDb: jest.fn(),
  createTaskDb: jest.fn(),
}));

jest.mock('../src/db/auth', () => ({
  closeAuthDb: jest.fn(),
}));

jest.mock('../src/queue', () => ({
  closeJobDb: jest.fn(),
}));

jest.mock('../src/coordinator/eventBus', () => ({
  eventBus: { store: { close: jest.fn() } },
}));

import { setupGracefulShutdown } from '../src/index';
import { stopAgentSync } from '../src/registry/sync';
import { closeDb } from '../src/db';
import { closeAgentDb, createAgentDb } from '../src/db/agents';
import { closeTaskDb, createTaskDb } from '../src/db/tasks';
import { closeJobDb } from '../src/queue';
import { closeAuthDb } from '../src/db/auth';
import { eventBus } from '../src/coordinator/eventBus';

describe('setupGracefulShutdown', () => {
  let mockProcessExit: jest.SpyInstance;
  let mockProcessOn: jest.SpyInstance;
  let mockHttpServer: any;
  let mockCloseApp: jest.Mock;
  let mockAgentDb: any;
  let mockTaskDb: any;
  let extras: {
    cleanupService: { stop: jest.Mock };
    reconciliationService: { stop: jest.Mock };
    maintenanceService: { stop: jest.Mock };
    errorRegistryMaintenance: { stop: jest.Mock };
    globalAgentRegistry: { shutdown: jest.Mock };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (closeTaskDb as jest.Mock).mockResolvedValue(undefined);
    mockProcessExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockProcessOn = jest.spyOn(process, 'on').mockImplementation(() => undefined as any);

    mockCloseApp = jest.fn((callback?: () => void) => {
      if (callback) callback();
    });

    mockHttpServer = {};

    mockAgentDb = {
      markAllOffline: jest.fn(),
    };
    (createAgentDb as jest.Mock).mockReturnValue(mockAgentDb);

    mockTaskDb = {
      failRunningTasks: jest.fn(),
    };
    (createTaskDb as jest.Mock).mockReturnValue(mockTaskDb);

    extras = {
      cleanupService: { stop: jest.fn() },
      reconciliationService: { stop: jest.fn() },
      maintenanceService: { stop: jest.fn() },
      errorRegistryMaintenance: { stop: jest.fn() },
      globalAgentRegistry: { shutdown: jest.fn() },
    };
  });

  afterEach(() => {
    mockProcessExit.mockRestore();
    mockProcessOn.mockRestore();
  });

  it('registers SIGTERM and SIGINT process signal handlers', () => {
    setupGracefulShutdown(mockHttpServer, mockCloseApp, { GRACEFUL_SHUTDOWN_TIMEOUT: 5 });

    expect(mockProcessOn).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(mockProcessOn).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('registers exactly one handler per signal (no duplicates)', () => {
    setupGracefulShutdown(mockHttpServer, mockCloseApp, { GRACEFUL_SHUTDOWN_TIMEOUT: 5 });

    const sigTermCalls = mockProcessOn.mock.calls.filter(
      ([signal]: [string]) => signal === 'SIGTERM'
    );
    const sigIntCalls = mockProcessOn.mock.calls.filter(
      ([signal]: [string]) => signal === 'SIGINT'
    );

    expect(sigTermCalls).toHaveLength(1);
    expect(sigIntCalls).toHaveLength(1);
  });

  it('performs the full multi-phase shutdown sequence on signal', async () => {
    const shutdown = setupGracefulShutdown(
      mockHttpServer,
      mockCloseApp,
      { GRACEFUL_SHUTDOWN_TIMEOUT: 5 },
      extras,
    );

    await shutdown('SIGTERM');

    // Phase 1: closeApp called (drains job worker)
    expect(mockCloseApp).toHaveBeenCalled();

    // Phase 2: background services stopped
    expect(stopAgentSync).toHaveBeenCalled();
    expect(extras.cleanupService.stop).toHaveBeenCalled();
    expect(extras.reconciliationService.stop).toHaveBeenCalled();
    expect(extras.maintenanceService.stop).toHaveBeenCalled();
    expect(extras.errorRegistryMaintenance.stop).toHaveBeenCalled();
    expect(extras.globalAgentRegistry.shutdown).toHaveBeenCalled();

    // Phase 3: failRunningTasks called to transition in-flight tasks
    expect(createTaskDb).toHaveBeenCalled();
    expect(mockTaskDb.failRunningTasks).toHaveBeenCalled();

    // Phase 4: markAllOffline called
    expect(createAgentDb).toHaveBeenCalled();
    expect(mockAgentDb.markAllOffline).toHaveBeenCalled();

    // Phase 5: all DB connections closed
    expect(closeDb).toHaveBeenCalled();
    expect(closeAgentDb).toHaveBeenCalled();
    expect(closeTaskDb).toHaveBeenCalled();
    expect(closeJobDb).toHaveBeenCalled();
    expect(closeAuthDb).toHaveBeenCalled();

    // Process exits with code 0
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('waits for worker drain, maintenance, and database close promises before exiting', async () => {
    let finishAppClose!: () => void;
    let finishMaintenance!: () => void;
    let finishTaskDbClose!: () => void;
    mockCloseApp = jest.fn((callback?: () => void) => { finishAppClose = callback!; });
    extras.maintenanceService.stop.mockImplementation(
      () => new Promise<void>((resolve) => { finishMaintenance = resolve; }),
    );
    (closeTaskDb as jest.Mock).mockImplementation(
      () => new Promise<void>((resolve) => { finishTaskDbClose = resolve; }),
    );

    const shutdown = setupGracefulShutdown(
      mockHttpServer,
      mockCloseApp,
      { GRACEFUL_SHUTDOWN_TIMEOUT: 5 },
      extras,
    );
    const shutdownPromise = shutdown('SIGTERM');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockCloseApp).toHaveBeenCalled();
    expect(extras.maintenanceService.stop).not.toHaveBeenCalled();
    expect(closeTaskDb).not.toHaveBeenCalled();
    expect(mockProcessExit).not.toHaveBeenCalled();

    finishAppClose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(extras.maintenanceService.stop).toHaveBeenCalled();
    expect(closeTaskDb).not.toHaveBeenCalled();
    expect(mockProcessExit).not.toHaveBeenCalled();

    finishMaintenance();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeTaskDb).toHaveBeenCalled();
    expect(mockProcessExit).not.toHaveBeenCalled();

    finishTaskDbClose();
    await shutdownPromise;
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('honours GRACEFUL_SHUTDOWN_TIMEOUT but waits for drains before exiting', async () => {
    jest.useFakeTimers();
    let finishServerClose!: () => void;

    mockCloseApp = jest.fn((callback?: () => void) => {
      finishServerClose = callback!;
    });

    const shutdown = setupGracefulShutdown(
      mockHttpServer,
      mockCloseApp,
      { GRACEFUL_SHUTDOWN_TIMEOUT: 25 },
    );

    const shutdownPromise = shutdown('SIGTERM');

    // At 10 seconds (old hardcoded value), should NOT have force-exited
    jest.advanceTimersByTime(10_000);
    expect(mockProcessExit).not.toHaveBeenCalled();

    // At 25 seconds (configured value), record the timeout without exiting
    jest.advanceTimersByTime(15_000);
    expect(mockProcessExit).not.toHaveBeenCalled();

    finishServerClose();
    await shutdownPromise;
    expect(mockProcessExit).toHaveBeenCalledWith(1);

    jest.useRealTimers();
  });

  it('defaults to 30s timeout when GRACEFUL_SHUTDOWN_TIMEOUT is unset', async () => {
    jest.useFakeTimers();
    let finishServerClose!: () => void;

    mockCloseApp = jest.fn((callback?: () => void) => {
      finishServerClose = callback!;
    });

    const shutdown = setupGracefulShutdown(mockHttpServer, mockCloseApp, {});
    const shutdownPromise = shutdown('SIGINT');

    jest.advanceTimersByTime(29_000);
    expect(mockProcessExit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2_000);
    expect(mockProcessExit).not.toHaveBeenCalled();

    finishServerClose();
    await shutdownPromise;
    expect(mockProcessExit).toHaveBeenCalledWith(1);

    jest.useRealTimers();
  });

  it('works without extras (backward compatible with the 3-argument call)', async () => {
    const shutdown = setupGracefulShutdown(mockHttpServer, mockCloseApp, { GRACEFUL_SHUTDOWN_TIMEOUT: 5 });

    await expect(shutdown('SIGTERM')).resolves.toBeUndefined();
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('is idempotent — second signal is ignored', async () => {
    const shutdown = setupGracefulShutdown(
      mockHttpServer,
      mockCloseApp,
      { GRACEFUL_SHUTDOWN_TIMEOUT: 5 },
      extras,
    );

    await shutdown('SIGTERM');
    await shutdown('SIGINT');

    // closeApp called only once despite two signals
    expect(mockCloseApp).toHaveBeenCalledTimes(1);
  });

  it('does not force-exit while server drain is still pending', async () => {
    jest.useFakeTimers();
    let finishServerClose!: () => void;

    mockCloseApp = jest.fn((callback?: () => void) => {
      finishServerClose = callback!;
    });

    const shutdown = setupGracefulShutdown(mockHttpServer, mockCloseApp, { GRACEFUL_SHUTDOWN_TIMEOUT: 10 });

    const shutdownPromise = shutdown('SIGINT');

    jest.advanceTimersByTime(10000);
    expect(mockProcessExit).not.toHaveBeenCalled();

    finishServerClose();
    await shutdownPromise;
    expect(mockProcessExit).toHaveBeenCalledWith(1);

    jest.useRealTimers();
  });
});
