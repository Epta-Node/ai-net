import { useState, useCallback } from 'react';
import type { PaymentEvent, DAGEvent } from '../types/api';

// Helper to determine payment amount based on agent type or node ID
const getAmountForAgent = (agentType?: string): string => {
  const type = agentType?.toLowerCase() || '';
  if (type.includes('research')) return '0.5';
  if (type.includes('risk')) return '0.3';
  if (type.includes('coding')) return '1.2';
  if (type.includes('design')) return '0.6';
  if (type.includes('report')) return '0.4';
  return '0.5';
};

export const useTaskPayments = (_taskId: string) => {
  const [payments, setPayments] = useState<PaymentEvent[]>([]);

  const updatePaymentFromEvent = useCallback((event: DAGEvent) => {
    if (!event.nodeId) return;

    const agentType = event.nodeId.replace('node_', '').replace('node-', '');

    setPayments(prev => {
      switch (event.type) {
        case 'payment_locked':
          return [
            ...prev,
            {
              amount: getAmountForAgent(agentType),
              direction: 'out' as const,
              counterparty: agentType,
              memo: `Payment locked for ${event.nodeId}`,
              timestamp: event.timestamp || new Date().toISOString(),
              txHash: '',
            }
          ];

        case 'payment_released':
          const txHash = (event.payload as any)?.txHash || 'mock-hash';
          // Check if there's already a locked payment for this nodeId to update it
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
              amount: getAmountForAgent(agentType),
              direction: 'out' as const,
              counterparty: agentType,
              memo: `Payment released for ${event.nodeId}`,
              timestamp: event.timestamp || new Date().toISOString(),
              txHash,
            }
          ];

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
