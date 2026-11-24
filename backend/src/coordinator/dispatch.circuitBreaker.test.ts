/**
 * Circuit-breaker integration for agent dispatch (#905).
 *
 * The logger is mocked so transition assertions do not depend on LOG_LEVEL.
 */
jest.mock('../utils/logger', () => {
  const logger = { warn: jest.fn(), info: jest.fn() };
  return { createLogger: jest.fn(() => logger), mockLogger: logger };
});

import type { AgentRegistration } from '../types/agent';
import type { DAGNode } from '../types/task';
import type { DispatchOptions } from './dispatch';

const agent: AgentRegistration = {
  id: 'agent-breaker-1',
  type: 'research',
  endpoint: 'http://agent-breaker:4001',
  cost: 10,
  status: 'online',
};

const otherAgent: AgentRegistration = { ...agent, id: 'agent-breaker-2', endpoint: 'http://agent-breaker-2:4001' };

const node: DAGNode = {
  nodeId: 'node_breaker',
  type: 'research',
  dependencies: [],
  status: 'running',
  prompt: 'Test dispatch circuit breaker',
};

const options: DispatchOptions = { timeoutMs: 500, maxRetries: 0, retryDelayMs: 0 };

function statusFetch(status = 503): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Service Unavailable',
    text: () => Promise.resolve(''),
  }) as unknown as typeof fetch;
}

function successFetch(body: unknown = { ok: true }): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

describe('agent dispatch circuit breaker (#905)', () => {
  let httpDispatch: typeof import('./dispatch').httpDispatch;
  let agentDispatchBreakerName: typeof import('./dispatch').agentDispatchBreakerName;
  let failureThreshold: typeof import('./dispatch').AGENT_DISPATCH_FAILURE_THRESHOLD;
  let resetTimeout: typeof import('./dispatch').AGENT_DISPATCH_RESET_TIMEOUT_MS;
  let breakers: typeof import('../services/circuitBreaker');
  let mockLogger: { warn: jest.Mock; info: jest.Mock };

  beforeAll(async () => {
    jest.resetModules();
    ({ mockLogger } = jest.requireMock('../utils/logger') as {
      mockLogger: { warn: jest.Mock; info: jest.Mock };
    });
    breakers = await import('../services/circuitBreaker');
    ({
      httpDispatch,
      agentDispatchBreakerName,
      AGENT_DISPATCH_FAILURE_THRESHOLD: failureThreshold,
      AGENT_DISPATCH_RESET_TIMEOUT_MS: resetTimeout,
    } = await import('./dispatch'));
  });

  beforeEach(() => {
    breakers._resetCircuitBreakerRegistry();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
  });

  it('uses five failures and a 60s reset timeout', () => {
    expect(failureThreshold).toBe(5);
    expect(resetTimeout).toBe(60_000);
    expect(agentDispatchBreakerName(agent.id)).toBe('agent-dispatch:agent-breaker-1');
  });

  it('opens after five failed dispatches and sheds further calls without fetching', async () => {
    const fetchMock = statusFetch();

    for (let i = 0; i < failureThreshold; i++) {
      await expect(
        httpDispatch(agent, node.nodeId, node, '', options, fetchMock),
      ).rejects.toThrow(/503/);
    }

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const status = breakers
      .getCircuitBreaker({
        name: agentDispatchBreakerName(agent.id),
        failureThreshold,
        recoveryTimeoutMs: resetTimeout,
      })
      .getStatus();
    expect(status).toMatchObject({
      state: 'OPEN',
      failures: 5,
      failureThreshold: 5,
      recoveryTimeoutMs: 60_000,
    });

    await expect(
      httpDispatch(agent, node.nodeId, node, '', options, fetchMock),
    ).rejects.toBeInstanceOf(breakers.CircuitOpenError);
    // No HTTP call was made while the circuit is open.
    expect(fetchMock).toHaveBeenCalledTimes(5);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'circuit_breaker_state_change',
        circuit: 'agent-dispatch:agent-breaker-1',
        agentId: agent.id,
        from: 'CLOSED',
        to: 'OPEN',
      }),
      expect.stringContaining('Circuit opened'),
    );
  });

  it('resets the failure count after a successful dispatch', async () => {
    let calls = 0;
    const fetchMock = jest.fn().mockImplementation(() => {
      calls += 1;
      if (calls <= 4) {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('{"ok":true}'),
      });
    }) as unknown as typeof fetch;

    for (let i = 0; i < 4; i++) {
      await expect(
        httpDispatch(agent, node.nodeId, node, '', options, fetchMock),
      ).rejects.toThrow(/503/);
    }
    await expect(
      httpDispatch(agent, node.nodeId, node, '', options, fetchMock),
    ).resolves.toEqual({ ok: true });

    expect(
      breakers.getCircuitBreaker({ name: agentDispatchBreakerName(agent.id) }).getStatus(),
    ).toMatchObject({ state: 'CLOSED', failures: 0 });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('allows a probe after 60s and closes the circuit when it succeeds', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    try {
      const fetchMock = statusFetch();

      for (let i = 0; i < failureThreshold; i++) {
        await expect(
          httpDispatch(agent, node.nodeId, node, '', options, fetchMock),
        ).rejects.toThrow(/503/);
      }

      const breaker = breakers.getCircuitBreaker({ name: agentDispatchBreakerName(agent.id) });
      expect(breaker.getState()).toBe('OPEN');

      jest.advanceTimersByTime(resetTimeout - 1);
      expect(breaker.getState()).toBe('OPEN');

      jest.advanceTimersByTime(1);
      expect(breaker.getState()).toBe('HALF_OPEN');

      await expect(
        httpDispatch(agent, node.nodeId, node, '', options, successFetch({ recovered: true })),
      ).resolves.toEqual({ recovered: true });

      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.getFailureCount()).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'OPEN', to: 'HALF_OPEN' }),
        expect.any(String),
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'HALF_OPEN', to: 'CLOSED' }),
        expect.any(String),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('isolates agents so one failing endpoint does not shed another', async () => {
    const failingFetch = statusFetch();
    for (let i = 0; i < failureThreshold; i++) {
      await expect(
        httpDispatch(agent, node.nodeId, node, '', options, failingFetch),
      ).rejects.toThrow(/503/);
    }

    await expect(
      httpDispatch(otherAgent, node.nodeId, node, '', options, successFetch()),
    ).resolves.toEqual({ ok: true });

    expect(
      breakers.getCircuitBreaker({ name: agentDispatchBreakerName(otherAgent.id) }).getState(),
    ).toBe('CLOSED');
  });
});
