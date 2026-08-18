import { renderHook, act } from '@testing-library/react';
import { useTaskPayments } from './useTaskPayments';
import type { DAGEvent, PaymentEvent } from '../types/api';

describe('useTaskPayments', () => {
  const mockTaskId = 'test-task';

  const mockInitialPayments: PaymentEvent[] = [
    {
      amount: '0.5',
      direction: 'out',
      counterparty: 'research',
      memo: 'Payment released for node-1',
      timestamp: '2024-01-01T00:00:00Z',
      txHash: 'mock-hash-1'
    },
    {
      amount: '0.3',
      direction: 'out', 
      counterparty: 'risk',
      memo: 'Payment locked for node-2',
      timestamp: '2024-01-01T01:00:00Z',
      txHash: ''
    }
  ];

  it('should initialize with empty payments', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    expect(result.current.payments).toEqual([]);
  });

  it('should initialize payments from provided data', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    act(() => {
      result.current.initializePayments(mockInitialPayments);
    });

    expect(result.current.payments).toEqual(mockInitialPayments);
  });

  it('should add locked payment on payment_locked event', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    const lockedEvent: DAGEvent = {
      type: 'payment_locked',
      taskId: mockTaskId,
      nodeId: 'node-research',
      timestamp: '2024-01-01T02:00:00Z'
    };

    act(() => {
      result.current.updatePaymentFromEvent(lockedEvent);
    });

    expect(result.current.payments).toHaveLength(1);
    
    const payment = result.current.payments[0];
    expect(payment.amount).toBe('0.5'); // research agent
    expect(payment.direction).toBe('out');
    expect(payment.counterparty).toBe('research');
    expect(payment.memo).toBe('Payment locked for node-research');
    expect(payment.txHash).toBe('');
  });

  it('should handle payment_released event by updating existing locked payment', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    // First add a locked payment
    const lockedEvent: DAGEvent = {
      type: 'payment_locked',
      taskId: mockTaskId,
      nodeId: 'node-coding',
      timestamp: '2024-01-01T02:00:00Z'
    };

    act(() => {
      result.current.updatePaymentFromEvent(lockedEvent);
    });

    // Then release it
    const releasedEvent: DAGEvent = {
      type: 'payment_released',
      taskId: mockTaskId,
      nodeId: 'node-coding',
      timestamp: '2024-01-01T03:00:00Z',
      payload: { txHash: 'real-tx-hash' }
    };

    act(() => {
      result.current.updatePaymentFromEvent(releasedEvent);
    });

    expect(result.current.payments).toHaveLength(1);
    
    const payment = result.current.payments[0];
    expect(payment.amount).toBe('1.2'); // coding agent
    expect(payment.txHash).toBe('real-tx-hash');
    expect(payment.memo).toBe('Payment released for node-coding');
    expect(payment.timestamp).toBe('2024-01-01T03:00:00Z');
  });

  it('should add new payment on payment_released event if no locked payment exists', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    const releasedEvent: DAGEvent = {
      type: 'payment_released',
      taskId: mockTaskId,
      nodeId: 'node-design',
      timestamp: '2024-01-01T03:00:00Z',
      payload: { txHash: 'direct-release-hash' }
    };

    act(() => {
      result.current.updatePaymentFromEvent(releasedEvent);
    });

    expect(result.current.payments).toHaveLength(1);
    
    const payment = result.current.payments[0];
    expect(payment.amount).toBe('0.6'); // design agent
    expect(payment.txHash).toBe('direct-release-hash');
    expect(payment.memo).toBe('Payment released for node-design');
  });

  it('should use mock hash when txHash is not provided in payload', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    const releasedEvent: DAGEvent = {
      type: 'payment_released',
      taskId: mockTaskId,
      nodeId: 'node-report',
      timestamp: '2024-01-01T03:00:00Z',
      payload: {}
    };

    act(() => {
      result.current.updatePaymentFromEvent(releasedEvent);
    });

    const payment = result.current.payments[0];
    expect(payment.txHash).toBe('mock-hash');
  });

  it('should ignore events without nodeId', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    const eventWithoutNodeId: DAGEvent = {
      type: 'payment_locked',
      taskId: mockTaskId,
      timestamp: '2024-01-01T03:00:00Z'
    };

    act(() => {
      result.current.updatePaymentFromEvent(eventWithoutNodeId);
    });

    expect(result.current.payments).toEqual([]);
  });

  it('should ignore non-payment events', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    const nodeEvent: DAGEvent = {
      type: 'node_started',
      taskId: mockTaskId,
      nodeId: 'node-1',
      timestamp: '2024-01-01T03:00:00Z'
    };

    act(() => {
      result.current.updatePaymentFromEvent(nodeEvent);
    });

    expect(result.current.payments).toEqual([]);
  });

  it('should calculate total cost correctly', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    act(() => {
      result.current.initializePayments(mockInitialPayments);
    });

    // Only count released payments (txHash !== '')
    expect(result.current.getTotalCost()).toBe(0.5);
  });

  it('should get node payment correctly', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    act(() => {
      result.current.initializePayments(mockInitialPayments);
    });

    const nodePayment = result.current.getNodePayment('node-1');
    expect(nodePayment).toEqual(mockInitialPayments[0]);

    const nonExistentPayment = result.current.getNodePayment('nonexistent');
    expect(nonExistentPayment).toBeUndefined();
  });

  it('should get locked payments correctly', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    act(() => {
      result.current.initializePayments(mockInitialPayments);
    });

    const lockedPayments = result.current.getLockedPayments();
    expect(lockedPayments).toHaveLength(1);
    expect(lockedPayments[0].txHash).toBe('');
  });

  it('should get released payments correctly', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    act(() => {
      result.current.initializePayments(mockInitialPayments);
    });

    const releasedPayments = result.current.getReleasedPayments();
    expect(releasedPayments).toHaveLength(1);
    expect(releasedPayments[0].txHash).toBe('mock-hash-1');
  });

  it('should determine correct amounts for different agent types', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    const testCases = [
      { nodeId: 'node-research', expectedAmount: '0.5' },
      { nodeId: 'node-risk', expectedAmount: '0.3' },
      { nodeId: 'node-coding', expectedAmount: '1.2' },
      { nodeId: 'node-design', expectedAmount: '0.6' },
      { nodeId: 'node-report', expectedAmount: '0.4' },
      { nodeId: 'node-unknown', expectedAmount: '0.5' }, // default
    ];

    testCases.forEach(({ nodeId }) => {
      const lockedEvent: DAGEvent = {
        type: 'payment_locked',
        taskId: mockTaskId,
        nodeId,
        timestamp: new Date().toISOString()
      };

      act(() => {
        result.current.updatePaymentFromEvent(lockedEvent);
      });
    });

    expect(result.current.payments).toHaveLength(testCases.length);
    
    testCases.forEach(({ expectedAmount }, index) => {
      expect(result.current.payments[index].amount).toBe(expectedAmount);
    });
  });

  it('should handle case-insensitive agent type matching', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    const lockedEvent: DAGEvent = {
      type: 'payment_locked',
      taskId: mockTaskId,
      nodeId: 'node-RESEARCH',
      timestamp: new Date().toISOString()
    };

    act(() => {
      result.current.updatePaymentFromEvent(lockedEvent);
    });

    const payment = result.current.payments[0];
    expect(payment.amount).toBe('0.5');
  });

  it('should handle node IDs with different formats', () => {
    const { result } = renderHook(() => useTaskPayments(mockTaskId));

    const testNodeIds = [
      'node-research',
      'node_research', 
      'research-node',
      'research_node'
    ];

    testNodeIds.forEach(nodeId => {
      const lockedEvent: DAGEvent = {
        type: 'payment_locked',
        taskId: mockTaskId,
        nodeId,
        timestamp: new Date().toISOString()
      };

      act(() => {
        result.current.updatePaymentFromEvent(lockedEvent);
      });
    });

    // All should result in research agent amount
    result.current.payments.forEach(payment => {
      expect(payment.amount).toBe('0.5');
    });
  });
});
