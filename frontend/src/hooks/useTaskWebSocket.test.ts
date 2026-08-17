import { renderHook, act } from '@testing-library/react';
import { useTaskWebSocket, UseTaskWebSocketOptions } from './useTaskWebSocket';
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

  constructor(public url: string) {
    MockWebSocket.instance = this;
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close'));
    }
  }

  send(_data: string) {
    // Mock implementation
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
    expect(MockWebSocket.instance!.url).toBe('ws://localhost:3001/tasks/test-task/stream');
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

    // Simulate 5 disconnections (max attempts)
    for (let i = 0; i < 5; i++) {
      act(() => {
        MockWebSocket.instance!.simulateClose();
        vi.advanceTimersByTime(1000 * Math.pow(2, i));
      });
    }

    // 6th disconnection should not schedule another reconnection
    const timeoutCallsBefore = setTimeoutSpy.mock.calls.length;
    
    act(() => {
      MockWebSocket.instance!.simulateClose();
    });

    expect(setTimeoutSpy.mock.calls.length).toBe(timeoutCallsBefore);
    
    setTimeoutSpy.mockRestore();
  });
});
