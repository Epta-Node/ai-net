import { AgentMonitorService } from './agentMonitor';
import type { AgentRegistration, AgentRegistry } from '../types/agent';
import { eventBus } from '../coordinator/eventBus';

describe('AgentMonitorService', () => {
  let agents: AgentRegistration[];
  let getAgentsMock: jest.Mock;
  let markOfflineMock: jest.Mock;
  let markOnlineMock: jest.Mock;
  let registry: AgentRegistry;
  let eventEmitSpy: jest.SpyInstance;

  beforeEach(() => {
    agents = [
      { id: 'agent-1', type: 'coding', endpoint: 'http://127.0.0.1:4001/agent-1', cost: 10, status: 'online' },
      { id: 'agent-2', type: 'coding', endpoint: 'http://127.0.0.1:4002/agent-2', cost: 20, status: 'online' },
    ];

    getAgentsMock = jest.fn().mockImplementation((type?: string) => {
      if (!type) return agents;
      return agents.filter((a) => a.type === type);
    });

    markOfflineMock = jest.fn().mockImplementation((agentId: string) => {
      const found = agents.find((a) => a.id === agentId);
      if (found) found.status = 'offline';
    });

    markOnlineMock = jest.fn().mockImplementation((agentId: string) => {
      const found = agents.find((a) => a.id === agentId);
      if (found) found.status = 'online';
    });

    registry = {
      getAgents: getAgentsMock,
      markOffline: markOfflineMock,
      markOnline: markOnlineMock,
    };

    eventEmitSpy = jest.spyOn(eventBus, 'emit');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs checkAllAgents and pings each registered agent endpoint', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    const monitor = new AgentMonitorService({
      agentRegistry: registry,
      intervalMs: 30_000,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await monitor.checkAllAgents();

    expect(getAgentsMock).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('marks agent offline after 3 consecutive failed health checks and emits AgentMarkedOffline', async () => {
    const mockFetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('agent-1')) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: true });
    });

    const monitor = new AgentMonitorService({
      agentRegistry: registry,
      intervalMs: 30_000,
      failureThreshold: 3,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    // 1st failed check
    await monitor.checkAgentHealth(agents[0]);
    expect(monitor.getFailureCount('agent-1')).toBe(1);
    expect(agents[0].status).toBe('online');

    // 2nd failed check
    await monitor.checkAgentHealth(agents[0]);
    expect(monitor.getFailureCount('agent-1')).toBe(2);
    expect(agents[0].status).toBe('online');

    // 3rd failed check -> should mark offline and emit event
    await monitor.checkAgentHealth(agents[0]);
    expect(monitor.getFailureCount('agent-1')).toBe(3);
    expect(agents[0].status).toBe('offline');
    expect(markOfflineMock).toHaveBeenCalledWith('agent-1');

    expect(eventEmitSpy).toHaveBeenCalledWith(
      'system',
      expect.objectContaining({
        type: 'AgentMarkedOffline',
        payload: expect.objectContaining({
          agentId: 'agent-1',
          consecutiveFailures: 3,
          status: 'offline',
          correlationId: expect.stringContaining('failover-agent-1'),
        }),
      })
    );
  });

  it('detects agent recovery and marks online when passing health check after being offline', async () => {
    agents[0].status = 'offline';

    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    const monitor = new AgentMonitorService({
      agentRegistry: registry,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await monitor.checkAgentHealth(agents[0]);

    expect(agents[0].status).toBe('online');
    expect(markOnlineMock).toHaveBeenCalledWith('agent-1');
    expect(monitor.getFailureCount('agent-1')).toBe(0);

    expect(eventEmitSpy).toHaveBeenCalledWith(
      'system',
      expect.objectContaining({
        type: 'AgentRecovered',
        payload: expect.objectContaining({
          agentId: 'agent-1',
          status: 'online',
        }),
      })
    );
  });

  it('starts and stops timer cleanly', () => {
    jest.useFakeTimers();
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    const monitor = new AgentMonitorService({
      agentRegistry: registry,
      intervalMs: 30_000,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    monitor.start();
    expect(() => monitor.stop()).not.toThrow();
    jest.useRealTimers();
  });
});
