import { setupGracefulShutdown } from '../src/index';
import { stopAgentSync } from '../src/registry/sync';
import { closeDb } from '../src/db';
import { closeAgentDb, createAgentDb } from '../src/db/agents';
import { closeTaskDb } from '../src/db/tasks';
import { closeJobDb } from '../src/queue';
import { eventBus } from '../src/coordinator/eventBus';

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

jest.mock('../src/queue', () => ({
  closeJobDb: jest.fn(),
}));

jest.mock('../src/coordinator/eventBus', () => ({
  eventBus: { store: { close: jest.fn() } },
}));

describe('setupGracefulShutdown', () => {
  let mockProcessExit: jest.SpyInstance;
  let mockProcessOn: jest.SpyInstance;
  let mockHttpServer: any;
  let mockCloseApp: jest.Mock;
  let mockAgentDb: any;
  let extras: {
    cleanupService: { stop: jest.Mock };
    reconciliationService: { stop: jest.Mock };
    globalAgentRegistry: { shutdown: jest.Mock };
  };

  beforeEach(() => {
    jest.clearAllMocks();
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

    extras = {
      cleanupService: { stop: jest.fn() },
      reconciliationService: { stop: jest.fn() },
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

  it('performs the full multi-phase shutdown sequence on signal', async () => {
    const shutdown = setupGracefulShutdown(
      mockHttpServer,
      mockCloseApp,
      { GRACEFUL_SHUTDOWN_TIMEOUT: 5 },
      extras,
    );

    await shutdown('SIGTERM');

    // Phase 1: closeApp called and completes — this is where the job worker's
    // own drain (awaited inside close()) happens, so in-flight jobs finish or
    // are left "active" for the next worker start to recover, not failed here.
    expect(mockCloseApp).toHaveBeenCalled();

    // Phase 2: agent sync and the extra background services are stopped
    expect(stopAgentSync).toHaveBeenCalled();
    expect(extras.cleanupService.stop).toHaveBeenCalled();
    expect(extras.reconciliationService.stop).toHaveBeenCalled();
    expect(extras.globalAgentRegistry.shutdown).toHaveBeenCalled();

    // Phase 3: markAllOffline called
    expect(mockAgentDb.markAllOffline).toHaveBeenCalled();

    // Phase 4: event store flushed (closed) and every DB connection closed
    expect(eventBus.store.close).toHaveBeenCalled();
    expect(closeDb).toHaveBeenCalled();
    expect(closeAgentDb).toHaveBeenCalled();
    expect(closeTaskDb).toHaveBeenCalled();
    expect(closeJobDb).toHaveBeenCalled();

    // Process exits with code 0
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('does not force-fail running tasks — in-flight work is left for the job worker to resume', async () => {
    // There is no failRunningTasks call anywhere in the shutdown sequence:
    // resumability comes from closeApp() awaiting the job worker's drain
    // (see api/app.ts's close()) and JobWorker.recoverIncompleteJobs() on
    // the next start(), not from marking tasks failed here.
    const { createTaskDb } = require('../src/db/tasks');
    const shutdown = setupGracefulShutdown(
      mockHttpServer,
      mockCloseApp,
      { GRACEFUL_SHUTDOWN_TIMEOUT: 5 },
      extras,
    );

    await shutdown('SIGTERM');

    expect(createTaskDb).not.toHaveBeenCalled();
  });

  it('works without extras (backward compatible with the 3-argument call)', async () => {
    const shutdown = setupGracefulShutdown(mockHttpServer, mockCloseApp, { GRACEFUL_SHUTDOWN_TIMEOUT: 5 });

    await expect(shutdown('SIGTERM')).resolves.toBeUndefined();
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('triggers forced exit on timeout if server drain hangs', async () => {
    jest.useFakeTimers();

    // Close app does not call callback, mimicking a hung connection
    mockCloseApp = jest.fn((_callback?: () => void) => {
      // Do nothing to trigger timeout
    });

    const shutdown = setupGracefulShutdown(mockHttpServer, mockCloseApp, { GRACEFUL_SHUTDOWN_TIMEOUT: 10 });

    // Start shutdown
    shutdown('SIGINT');

    // Fast-forward timers by 10 seconds
    jest.advanceTimersByTime(10000);

    // The force exit timeout should trigger process.exit(1)
    expect(mockProcessExit).toHaveBeenCalledWith(1);

    jest.useRealTimers();
  });
});
