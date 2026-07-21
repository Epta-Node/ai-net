import { setupGracefulShutdown } from '../src/index';
import { stopAgentSync } from '../src/registry/sync';
import { closeDb } from '../src/db';
import { closeAgentDb, createAgentDb } from '../src/db/agents';
import { closeTaskDb, createTaskDb } from '../src/db/tasks';

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

describe('setupGracefulShutdown', () => {
  let mockProcessExit: jest.SpyInstance;
  let mockProcessOn: jest.SpyInstance;
  let mockHttpServer: any;
  let mockCloseApp: jest.Mock;
  let mockTaskDb: any;
  let mockAgentDb: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockProcessOn = jest.spyOn(process, 'on').mockImplementation(() => undefined as any);
    
    mockCloseApp = jest.fn((callback?: () => void) => {
      if (callback) callback();
    });

    mockHttpServer = {};

    mockTaskDb = {
      failRunningTasks: jest.fn(),
    };
    (createTaskDb as jest.Mock).mockReturnValue(mockTaskDb);

    mockAgentDb = {
      markAllOffline: jest.fn(),
    };
    (createAgentDb as jest.Mock).mockReturnValue(mockAgentDb);
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

  it('performs full multi-phase shutdown sequence on signal', async () => {
    const shutdown = setupGracefulShutdown(mockHttpServer, mockCloseApp, { GRACEFUL_SHUTDOWN_TIMEOUT: 5 });

    await shutdown('SIGTERM');

    // Phase 1: closeApp called and completes
    expect(mockCloseApp).toHaveBeenCalled();

    // Phase 2: stopAgentSync called
    expect(stopAgentSync).toHaveBeenCalled();

    // Phase 3: failRunningTasks called
    expect(mockTaskDb.failRunningTasks).toHaveBeenCalled();

    // Phase 4: markAllOffline called
    expect(mockAgentDb.markAllOffline).toHaveBeenCalled();

    // Phase 5: DB connections closed
    expect(closeDb).toHaveBeenCalled();
    expect(closeAgentDb).toHaveBeenCalled();
    expect(closeTaskDb).toHaveBeenCalled();

    // Process exits with code 0
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
