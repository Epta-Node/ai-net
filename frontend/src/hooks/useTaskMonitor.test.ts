import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DAGNode, TaskResponse } from '../types/api';
import { apiClient } from '../services/api';
import { useTaskMonitor } from './useTaskMonitor';

const reconnectStream = vi.hoisted(() => vi.fn());

vi.mock('../services/api', () => ({
  apiClient: { get: vi.fn() },
}));

vi.mock('./useTaskWebSocket', () => ({
  useTaskWebSocket: () => ({
    isConnected: false,
    status: 'disconnected',
    reconnect: reconnectStream,
  }),
}));

vi.mock('./useWallet', () => ({ useWallet: () => ({ publicKey: 'GCONNECTEDWALLET' }) }));

const getTask = vi.mocked(apiClient.get);

const node = (overrides: Partial<DAGNode>): DAGNode => ({
  nodeId: 'node-1',
  agentType: 'research',
  prompt: 'Summarise the market',
  dependsOn: [],
  status: 'completed',
  ...overrides,
});

const task = (dag: DAGNode[]): TaskResponse => ({
  taskId: 'task-1',
  prompt: 'Summarise the market',
  walletPublicKey: 'GBRPYHIL2CI3WHZDTOOQFC6EB4PSQUMACTUN4QE2LBNVQWSRUCF6XX2H',
  status: 'completed',
  dag,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:05:00.000Z',
});

describe('useTaskMonitor initial payments', () => {
  beforeEach(() => {
    getTask.mockReset();
    reconnectStream.mockReset();
  });

  it('exposes the WebSocket manual-reconnect action to the task page', async () => {
    getTask.mockResolvedValue(task([]));
    const { result } = renderHook(() => useTaskMonitor('task-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.reconnectStream).toBe(reconnectStream);
  });

  it('builds a timeline entry from a completed node carrying a payment result', async () => {
    getTask.mockResolvedValue(
      task([
        node({
          result: {
            summary: 'Done',
            txHash: 'abc123',
            amount: 0.5,
            timestamp: '2026-09-01T10:03:00.000Z',
          },
        }),
      ])
    );

    const { result } = renderHook(() => useTaskMonitor('task-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getTask).toHaveBeenCalledWith('/api/tasks/task-1');
    expect(result.current.payments).toEqual([
      {
        amount: '0.5',
        direction: 'out',
        counterparty: 'research',
        memo: 'Payment released for node-1',
        timestamp: '2026-09-01T10:03:00.000Z',
        txHash: 'abc123',
      },
    ]);
  });

  it('falls back to the task updatedAt when the payment result has no timestamp', async () => {
    getTask.mockResolvedValue(task([node({ result: { txHash: 'abc123', amount: '1.25' } })]));

    const { result } = renderHook(() => useTaskMonitor('task-1'));

    await waitFor(() => expect(result.current.payments).toHaveLength(1));
    expect(result.current.payments[0]).toMatchObject({
      amount: '1.25',
      timestamp: '2026-09-01T10:05:00.000Z',
    });
  });

  it('skips nodes whose result does not match the payment shape', async () => {
    getTask.mockResolvedValue(
      task([
        node({ nodeId: 'no-result', result: undefined }),
        node({ nodeId: 'plain-text', result: 'report body' }),
        node({ nodeId: 'no-tx', result: { amount: 2 } }),
        node({ nodeId: 'no-amount', result: { txHash: 'abc123' } }),
        node({ nodeId: 'zero-amount', result: { txHash: 'abc123', amount: 0 } }),
        node({ nodeId: 'bad-tx', result: { txHash: 42, amount: 2 } }),
        node({
          nodeId: 'bad-timestamp',
          result: { txHash: 'abc123', amount: 2, timestamp: 1700000000 },
        }),
      ])
    );

    const { result } = renderHook(() => useTaskMonitor('task-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.task?.dag).toHaveLength(7);
    expect(result.current.payments).toEqual([]);
  });

  it('surfaces fetch errors without hanging in loading', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getTask.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useTaskMonitor('task-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatchObject({ message: 'boom' });
    expect(result.current.task).toBeNull();
    errSpy.mockRestore();
  });

  it('does not fetch when taskId is undefined (empty path)', async () => {
    const { result } = renderHook(() => useTaskMonitor(undefined));

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(getTask).not.toHaveBeenCalled();
    expect(result.current.task).toBeNull();
  });

  it('refetch re-requests the task', async () => {
    getTask.mockResolvedValue(task([]));
    const { result } = renderHook(() => useTaskMonitor('task-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getTask).toHaveBeenCalledTimes(1);

    result.current.refetch();
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  });
});
