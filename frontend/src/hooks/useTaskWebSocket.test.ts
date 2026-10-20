import { renderHook, act } from '@testing-library/react';
import { reconnectDelayMs, useTaskWebSocket, UseTaskWebSocketOptions } from './useTaskWebSocket';
import type { DAGEvent } from '../types/api';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

// Mock WebSocket
class MockWebSocket {
  static instance: MockWebSocket | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instance = this;
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close'));
    }
  }

  send(data: string) {
    this.sent.push(data);
  }

  // Test helpers
  simulateOpen() {
    this.readyState = WebSocket.OPEN;
    if (this.onopen) {
      this.onopen(new Event('open'));
    }
  }

  simulateMessage(data: any) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }

  simulateError() {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }

  simulateClose() {
    this.readyState = WebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close'));
    }
  }
}

// Replace global WebSocket
(global as any).WebSocket = MockWebSocket;

describe('useTaskWebSocket', () => {
  beforeEach(() => {
    MockWebSocket.instance = null;
    sessionStorage.clear();
    vi.clearAllTimers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('should initialize with connecting status', () => {
    const mockOptions: UseTaskWebSocketOptions = {
      taskId: 'test-task',
      onMessage: vi.fn(),
    };

    const { result } = renderHook(() => useTaskWebSocket(mockOptions));

    expect(result.current.isConnected).toBe(false);
    expect(result.current.status).toBe('connecting');
    expect(MockWebSocket.instance).toBeTruthy();
    // Same-origin base + /api/tasks prefix (see getDefaultWsBaseUrl).
    expect(MockWebSocket.instance!.url).toContain('/api/tasks/test-task/stream');
  });

  it('should set connected status when WebSocket opens', () => {
    const mockOptions: UseTaskWebSocketOptions = {
      taskId: 'test-task',
      onMessage: vi.fn(),
      onConnect: vi.fn(),
    };

    const { result } = renderHook(() => useTaskWebSocket(mockOptions));

    act(() => {
      MockWebSocket.instance!.simulateOpen();
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.status).toBe('connected');
    expect(mockOptions.onConnect).toHaveBeenCalled();
  });

  it('does not send auth on open; answers the server auth_challenge instead', async () => {
    const signChallenge = vi.fn(async (nonce: string) => `sig-for-${nonce}`);
    renderHook(() =>
      useTaskWebSocket({
        taskId: 'owned-task',
        walletPublicKey: 'GOWNER',
        signChallenge,
        onMessage: vi.fn(),
      })
    );

    act(() => MockWebSocket.instance!.simulateOpen());

    // Challenge-response: nothing is sent until the server issues a nonce.
    expect(MockWebSocket.instance!.sent).toHaveLength(0);

    act(() => MockWebSocket.instance!.simulateMessage({ type: 'auth_challenge', nonce: 'n-1' }));
    await act(async () => {});

    expect(signChallenge).toHaveBeenCalledWith('n-1');
    expect(MockWebSocket.instance!.sent[0]).toBe(
      JSON.stringify({ walletPublicKey: 'GOWNER', nonce: 'n-1', signature: 'sig-for-n-1' })
    );
  });

  it('does not open an authenticated stream without a wallet and reports the requirement', () => {
    const { result } = renderHook(() =>
      useTaskWebSocket({
        taskId: 'owned-task',
        requireAuthentication: true,
        onMessage: vi.fn(),
      })
    );

    expect(MockWebSocket.instance).toBeNull();
    expect(result.current.status).toBe('authentication-required');
  });

  it('should handle incoming messages', () => {
    const onMessage = vi.fn();
    const mockOptions: UseTaskWebSocketOptions = {
      taskId: 'test-task',
      onMessage,
    };

    renderHook(() => useTaskWebSocket(mockOptions));

    const testEvent: DAGEvent = {
      type: 'node_started',
      taskId: 'test-task',
      nodeId: 'node-1',
      timestamp: new Date().toISOString(),
    };

    act(() => {
      MockWebSocket.instance!.simulateMessage(testEvent);
    });

    expect(onMessage).toHaveBeenCalledWith(testEvent);
  });

  it('should handle WebSocket errors', () => {
    const mockOptions: UseTaskWebSocketOptions = {
      taskId: 'test-task',
      onMessage: vi.fn(),
    };

    const { result } = renderHook(() => useTaskWebSocket(mockOptions));

    act(() => {
      MockWebSocket.instance!.simulateError();
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.status).toBe('error');
  });

  it('should handle WebSocket disconnect and trigger reconnection', () => {
    const onDisconnect = vi.fn();
    const mockOptions: UseTaskWebSocketOptions = {
      taskId: 'test-task',
      onMessage: vi.fn(),
      onDisconnect,
    };

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const { result } = renderHook(() => useTaskWebSocket(mockOptions));

    act(() => {
      MockWebSocket.instance!.simulateClose();
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.status).toBe('disconnected');
    expect(onDisconnect).toHaveBeenCalled();

    // Check if reconnection is scheduled
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);

    setTimeoutSpy.mockRestore();
  });

  it('should manually reconnect', () => {
    const mockOptions: UseTaskWebSocketOptions = {
      taskId: 'test-task',
      onMessage: vi.fn(),
    };

    const { result } = renderHook(() => useTaskWebSocket(mockOptions));

    act(() => {
      result.current.reconnect();
    });

    expect(MockWebSocket.instance).toBeTruthy();
    expect(result.current.status).toBe('connecting');
  });

  it('should disconnect and clean up', () => {
    const mockOptions: UseTaskWebSocketOptions = {
      taskId: 'test-task',
      onMessage: vi.fn(),
    };

    const { result } = renderHook(() => useTaskWebSocket(mockOptions));

    act(() => {
      result.current.disconnect();
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.status).toBe('disconnected');
  });

  it('should implement exponential backoff for reconnection', () => {
    const mockOptions: UseTaskWebSocketOptions = {
      taskId: 'test-task',
      onMessage: vi.fn(),
    };

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    renderHook(() => useTaskWebSocket(mockOptions));

    // Simulate multiple disconnections
    act(() => {
      MockWebSocket.instance!.simulateClose();
    });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);

    // Fast forward and simulate another disconnection
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    act(() => {
      MockWebSocket.instance!.simulateClose();
    });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);

    setTimeoutSpy.mockRestore();
  });

  it('should stop reconnecting after max attempts', () => {
    const mockOptions: UseTaskWebSocketOptions = {
      taskId: 'test-task',
      onMessage: vi.fn(),
    };

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    renderHook(() => useTaskWebSocket(mockOptions));

    // Simulate 8 disconnections (max attempts)
    for (let i = 0; i < 8; i++) {
      act(() => {
        MockWebSocket.instance!.simulateClose();
        vi.advanceTimersByTime(1000 * Math.pow(2, i));
      });
    }

    // 9th disconnection should not schedule another reconnection
    const timeoutCallsBefore = setTimeoutSpy.mock.calls.length;

    act(() => {
      MockWebSocket.instance!.simulateClose();
    });

    expect(setTimeoutSpy.mock.calls.length).toBe(timeoutCallsBefore);

    setTimeoutSpy.mockRestore();
  });

  it('recovers after exhausting automatic retries when manually reconnected', () => {
    const { result } = renderHook(() =>
      useTaskWebSocket({
        taskId: 'test-task',
        onMessage: vi.fn(),
        maxReconnectAttempts: 2,
      })
    );

    act(() => MockWebSocket.instance!.simulateClose());
    act(() => vi.advanceTimersByTime(1000));
    act(() => MockWebSocket.instance!.simulateClose());
    act(() => vi.advanceTimersByTime(2000));
    act(() => MockWebSocket.instance!.simulateClose());

    expect(result.current.status).toBe('disconnected');
    const exhaustedSocket = MockWebSocket.instance;

    act(() => result.current.reconnect());
    expect(MockWebSocket.instance).not.toBe(exhaustedSocket);
    expect(result.current.status).toBe('connecting');

    act(() => MockWebSocket.instance!.simulateOpen());
    expect(result.current.status).toBe('connected');
    expect(result.current.isConnected).toBe(true);
  });

  it('caps the reconnect backoff at 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 7].map((n) => reconnectDelayMs(n))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });

  it('spreads jittered reconnects across the jitter window', () => {
    const delays = Array.from({ length: 100 }, () => reconnectDelayMs(0, 6000));
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...delays)).toBeLessThan(7000);
    expect(new Set(delays).size).toBeGreaterThan(50);
  });

  it('exposes the attempt and countdown while reconnecting', () => {
    const { result } = renderHook(() =>
      useTaskWebSocket({ taskId: 'test-task', onMessage: vi.fn() })
    );

    act(() => MockWebSocket.instance!.simulateOpen());
    act(() => MockWebSocket.instance!.simulateClose());
    expect(result.current.reconnectAttempt).toBe(1);
    expect(result.current.reconnectIn).toBe(1000);

    act(() => vi.advanceTimersByTime(1000));
    act(() => MockWebSocket.instance!.simulateOpen());
    expect(result.current.reconnectAttempt).toBe(0);
    expect(result.current.reconnectIn).toBe(0);
  });

  it('does not reconnect once the task has reached a terminal state', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    renderHook(() =>
      useTaskWebSocket({ taskId: 'test-task', onMessage: vi.fn(), stopReconnecting: true })
    );
    const callsBefore = setTimeoutSpy.mock.calls.length;

    act(() => MockWebSocket.instance!.simulateClose());

    expect(setTimeoutSpy.mock.calls.length).toBe(callsBefore);
    setTimeoutSpy.mockRestore();
  });

  it('does not open a socket when taskId is empty', () => {
    renderHook(() => useTaskWebSocket({ taskId: '', onMessage: vi.fn() }));
    expect(MockWebSocket.instance).toBeNull();
  });

  it('answers server pings without forwarding them to onMessage', () => {
    const onMessage = vi.fn();
    renderHook(() => useTaskWebSocket({ taskId: 'test-task', onMessage }));

    act(() => MockWebSocket.instance!.simulateMessage({ type: 'ping' }));
    expect(MockWebSocket.instance!.sent[0]).toBe(JSON.stringify({ type: 'pong' }));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores unparseable frames without crashing', () => {
    const onMessage = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderHook(() => useTaskWebSocket({ taskId: 'test-task', onMessage }));

    act(() => {
      MockWebSocket.instance!.onmessage?.(
        new MessageEvent('message', { data: 'not-json{{{' })
      );
    });
    expect(onMessage).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('resumes from the persisted cursor via lastEventId', () => {
    sessionStorage.setItem('ai-net:ws-cursor:cursor-task', '7');
    renderHook(() => useTaskWebSocket({ taskId: 'cursor-task', onMessage: vi.fn() }));
    expect(MockWebSocket.instance!.url).toContain('lastEventId=7');
    sessionStorage.removeItem('ai-net:ws-cursor:cursor-task');
  });

  it('cleans up the socket on unmount without scheduling a reconnect', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const { unmount } = renderHook(() =>
      useTaskWebSocket({ taskId: 'test-task', onMessage: vi.fn() })
    );
    const callsBefore = setTimeoutSpy.mock.calls.length;
    unmount();
    // The close triggered by unmount must not schedule a reconnect.
    expect(setTimeoutSpy.mock.calls.length).toBe(callsBefore);
    setTimeoutSpy.mockRestore();
  });
});
