import { useState, useEffect, useCallback } from 'react';
import type { TaskResponse, DAGEvent, DAGNode, PaymentEvent } from '../types/api';
import { apiClient } from '../services/api';
import { useTaskWebSocket } from './useTaskWebSocket';
import { useNodeState } from './useNodeState';
import { useTaskPayments } from './useTaskPayments';
import { useTaskOutputs } from './useTaskOutputs';
import { useWallet } from './useWallet';

/** A completed node's result that records the payment released for it. */
interface PaymentResult {
  txHash: string;
  amount: string | number;
  timestamp?: string;
}

const isPaymentResult = (value: unknown): value is PaymentResult => {
  if (typeof value !== 'object' || value === null) return false;
  const { txHash, amount, timestamp } = value as Record<string, unknown>;
  const hasAmount =
    (typeof amount === 'string' && amount !== '') || (typeof amount === 'number' && amount > 0);
  return (
    typeof txHash === 'string' &&
    txHash !== '' &&
    hasAmount &&
    (timestamp === undefined || typeof timestamp === 'string')
  );
};

export const useTaskMonitor = (taskId: string | undefined) => {
  const [task, setTask] = useState<TaskResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const { publicKey } = useWallet();

  // Initialize sub-hooks
  const nodeState = useNodeState(taskId || '');
  const paymentState = useTaskPayments(taskId || '');
  const outputState = useTaskOutputs(taskId || '');

  // Handle WebSocket events
  const handleWebSocketMessage = useCallback(
    (event: DAGEvent) => {
      // Update node state
      nodeState.updateNodeFromEvent(event);

      // Update payment state
      paymentState.updatePaymentFromEvent(event);

      // Update output state
      outputState.updateOutputFromEvent(event);

      // Update task state for global events
      if (event.type === 'task_completed') {
        setTask((prev) => (prev ? { ...prev, status: 'completed' } : null));
      } else if (event.type === 'task_failed') {
        setTask((prev) => (prev ? { ...prev, status: 'failed' } : null));
      }
    },
    [nodeState, paymentState, outputState]
  );

  // WebSocket connection
  const {
    isConnected,
    status: wsStatus,
    reconnectAttempt,
    reconnectIn,
    reconnect: reconnectStream,
  } = useTaskWebSocket({
    taskId: taskId || '',
    onMessage: handleWebSocketMessage,
    walletPublicKey: publicKey ?? undefined,
    requireAuthentication: true,
    stopReconnecting: task?.status === 'completed' || task?.status === 'failed',
  });

  const fetchTask = async (id: string) => {
    try {
      setLoading(true);
      const data = await apiClient.get<TaskResponse>(`/api/tasks/${id}`);
      setTask(data);
      if (data.dag) {
        // Initialize all sub-hooks with fetched data
        nodeState.initializeNodes(data.dag);

        const completedNodes = data.dag.filter((node) => node.status === 'completed');

        // Only include payments that have actual amount and transaction data.
        // Do not fabricate placeholders like 'mock-hash' or estimated amounts.
        const initialPayments: PaymentEvent[] = data.dag
          .filter((node): node is DAGNode & { result: PaymentResult } =>
            isPaymentResult(node.result)
          )
          .map((node) => ({
            amount: String(node.result.amount),
            direction: 'out' as const,
            counterparty: node.agentType || 'agent',
            memo: `Payment released for ${node.nodeId}`,
            timestamp: node.result.timestamp || data.updatedAt,
            txHash: node.result.txHash,
          }));

        outputState.initializeOutputs(completedNodes);
        paymentState.initializePayments(initialPayments);
      }
      setError(null);
    } catch (err: any) {
      console.error('Failed to fetch task details:', err);
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!taskId) return;

    fetchTask(taskId);
  }, [taskId]);

  return {
    task,
    loading,
    error,
    wsStatus,
    reconnectAttempt,
    reconnectIn,
    reconnectStream,
    nodes: nodeState.nodes,
    payments: paymentState.payments,
    outputs: outputState.outputs,
    finalResult: outputState.finalResult,
    isConnected,
    refetch: () => taskId && fetchTask(taskId),
  };
};
