import { useState, useCallback } from 'react';
import type { PaymentEvent, DAGEvent } from '../types/api';

export const useTaskPayments = (_taskId: string) => {
  const [payments, setPayments] = useState<PaymentEvent[]>([]);

  const updatePaymentFromEvent = useCallback((event: DAGEvent) => {
    if (!event.nodeId) return;

    const agentType = event.nodeId.replace('node_', '').replace('node-', '');

    setPayments(prev => {
      switch (event.type) {
        case 'payment_locked': {
          const amount = (event.payload as any)?.amount;
          if (!amount) return prev;
          return [
            ...prev,
            {
              amount,
              direction: 'out' as const,
              counterparty: agentType,
              memo: `Payment locked for ${event.nodeId}`,
              timestamp: event.timestamp || new Date().toISOString(),
              txHash: '',
            }
          ];
        }

        case 'payment_released': {
          const amount = (event.payload as any)?.amount;
          const txHash = (event.payload as any)?.txHash;
          if (!amount || !txHash) return prev;
          const existingIndex = prev.findIndex(p =>
            p.memo?.includes(event.nodeId!) && p.txHash === ''
          );

          if (existingIndex > -1) {
            return prev.map((p, idx) =>
              idx === existingIndex
                ? {
                    ...p,
                    txHash,
                    timestamp: event.timestamp || p.timestamp,
                    memo: `Payment released for ${event.nodeId}`
                  }
                : p
            );
          }

          return [
            ...prev,
            {
              amount,
              direction: 'out' as const,
              counterparty: agentType,
              memo: `Payment released for ${event.nodeId}`,
              timestamp: event.timestamp || new Date().toISOString(),
              txHash,
            }
          ];
        }

        default:
          return prev;
      }
    });
  }, []);

  const getTotalCost = useCallback((): number => {
    return payments
      .filter(p => p.direction === 'out' && p.txHash !== '') // Only count released payments
      .reduce((sum, p) => sum + parseFloat(p.amount), 0);
  }, [payments]);

  const getNodePayment = useCallback((nodeId: string): PaymentEvent | undefined => {
    return payments.find(p => p.memo?.includes(nodeId));
  }, [payments]);

  const getLockedPayments = useCallback((): PaymentEvent[] => {
    return payments.filter(p => p.txHash === '');
  }, [payments]);

  const getReleasedPayments = useCallback((): PaymentEvent[] => {
    return payments.filter(p => p.txHash !== '');
  }, [payments]);

  const initializePayments = useCallback((initialPayments: PaymentEvent[]) => {
    setPayments(initialPayments);
  }, []);

  return {
    payments,
    updatePaymentFromEvent,
    getTotalCost,
    getNodePayment,
    getLockedPayments,
    getReleasedPayments,
    initializePayments,
  };
};
