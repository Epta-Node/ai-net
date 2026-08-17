import { renderHook, act } from '@testing-library/react';
import { useNodeState } from './useNodeState';
import type { DAGEvent, DAGNode } from '../types/api';

describe('useNodeState', () => {
  const mockTaskId = 'test-task';

  const mockNodes: DAGNode[] = [
    {
      nodeId: 'node-1',
      agentType: 'research',
      prompt: 'Research task',
      dependsOn: [],
      status: 'pending'
    },
    {
      nodeId: 'node-2', 
      agentType: 'coding',
      prompt: 'Coding task',
      dependsOn: ['node-1'],
      status: 'pending'
    },
    {
      nodeId: 'node-3',
      agentType: 'report',
      prompt: 'Report task',
      dependsOn: ['node-2'],
      status: 'completed',
      result: { summary: 'Test result' }
    }
  ];

  it('should initialize with empty nodes', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    expect(result.current.nodes).toEqual([]);
  });

  it('should initialize nodes from provided data', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    act(() => {
      result.current.initializeNodes(mockNodes);
    });

    expect(result.current.nodes).toEqual(mockNodes);
  });

  it('should update node status on node_started event', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    act(() => {
      result.current.initializeNodes(mockNodes);
    });

    const startedEvent: DAGEvent = {
      type: 'node_started',
      taskId: mockTaskId,
      nodeId: 'node-1',
      timestamp: new Date().toISOString()
    };

    act(() => {
      result.current.updateNodeFromEvent(startedEvent);
    });

    const updatedNode = result.current.nodes.find(n => n.nodeId === 'node-1');
    expect(updatedNode?.status).toBe('running');
  });

  it('should update node status and result on node_completed event', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    act(() => {
      result.current.initializeNodes(mockNodes);
    });

    const payload = { summary: 'Completed successfully' };
    const completedEvent: DAGEvent = {
      type: 'node_completed',
      taskId: mockTaskId,
      nodeId: 'node-1',
      timestamp: new Date().toISOString(),
      payload
    };

    act(() => {
      result.current.updateNodeFromEvent(completedEvent);
    });

    const updatedNode = result.current.nodes.find(n => n.nodeId === 'node-1');
    expect(updatedNode?.status).toBe('completed');
    expect(updatedNode?.result).toEqual(payload);
  });

  it('should update node status and error on node_failed event', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    act(() => {
      result.current.initializeNodes(mockNodes);
    });

    const payload = { error: 'Node execution failed' };
    const failedEvent: DAGEvent = {
      type: 'node_failed',
      taskId: mockTaskId,
      nodeId: 'node-1',
      timestamp: new Date().toISOString(),
      payload
    };

    act(() => {
      result.current.updateNodeFromEvent(failedEvent);
    });

    const updatedNode = result.current.nodes.find(n => n.nodeId === 'node-1');
    expect(updatedNode?.status).toBe('failed');
    expect(updatedNode?.error).toBe('Node execution failed');
  });

  it('should handle node_failed event with default error message', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    act(() => {
      result.current.initializeNodes(mockNodes);
    });

    const failedEvent: DAGEvent = {
      type: 'node_failed',
      taskId: mockTaskId,
      nodeId: 'node-1',
      timestamp: new Date().toISOString(),
      payload: {}
    };

    act(() => {
      result.current.updateNodeFromEvent(failedEvent);
    });

    const updatedNode = result.current.nodes.find(n => n.nodeId === 'node-1');
    expect(updatedNode?.status).toBe('failed');
    expect(updatedNode?.error).toBe('Node execution failed');
  });

  it('should ignore events without nodeId', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    act(() => {
      result.current.initializeNodes(mockNodes);
    });

    const eventWithoutNodeId: DAGEvent = {
      type: 'node_started',
      taskId: mockTaskId,
      timestamp: new Date().toISOString()
    };

    act(() => {
      result.current.updateNodeFromEvent(eventWithoutNodeId);
    });

    // Nodes should remain unchanged
    expect(result.current.nodes).toEqual(mockNodes);
  });

  it('should get node status correctly', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    act(() => {
      result.current.initializeNodes(mockNodes);
    });

    expect(result.current.getNodeStatus('node-1')).toBe('pending');
    expect(result.current.getNodeStatus('node-3')).toBe('completed');
    expect(result.current.getNodeStatus('nonexistent')).toBeUndefined();
  });

  it('should get completed nodes correctly', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    act(() => {
      result.current.initializeNodes(mockNodes);
    });

    const completedNodes = result.current.getCompletedNodes();
    expect(completedNodes).toHaveLength(1);
    expect(completedNodes[0].nodeId).toBe('node-3');
  });

  it('should get running nodes correctly', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    const nodesWithRunning = [
      ...mockNodes.slice(0, 2),
      { ...mockNodes[1], status: 'running' as const },
      mockNodes[2]
    ];

    act(() => {
      result.current.initializeNodes(nodesWithRunning);
    });

    const runningNodes = result.current.getRunningNodes();
    expect(runningNodes).toHaveLength(1);
    expect(runningNodes[0].nodeId).toBe('node-2');
  });

  it('should get failed nodes correctly', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    const nodesWithFailed = [
      { ...mockNodes[0], status: 'failed' as const, error: 'Test error' },
      ...mockNodes.slice(1)
    ];

    act(() => {
      result.current.initializeNodes(nodesWithFailed);
    });

    const failedNodes = result.current.getFailedNodes();
    expect(failedNodes).toHaveLength(1);
    expect(failedNodes[0].nodeId).toBe('node-1');
  });

  it('should get node by id correctly', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    act(() => {
      result.current.initializeNodes(mockNodes);
    });

    const node = result.current.getNodeById('node-2');
    expect(node).toEqual(mockNodes[1]);

    const nonExistentNode = result.current.getNodeById('nonexistent');
    expect(nonExistentNode).toBeUndefined();
  });

  it('should handle events for non-existent nodes gracefully', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    act(() => {
      result.current.initializeNodes(mockNodes);
    });

    const eventForNonExistentNode: DAGEvent = {
      type: 'node_started',
      taskId: mockTaskId,
      nodeId: 'nonexistent-node',
      timestamp: new Date().toISOString()
    };

    act(() => {
      result.current.updateNodeFromEvent(eventForNonExistentNode);
    });

    // Nodes should remain unchanged
    expect(result.current.nodes).toEqual(mockNodes);
  });

  it('should ignore non-node events', () => {
    const { result } = renderHook(() => useNodeState(mockTaskId));

    act(() => {
      result.current.initializeNodes(mockNodes);
    });

    const taskEvent: DAGEvent = {
      type: 'task_completed',
      taskId: mockTaskId,
      timestamp: new Date().toISOString()
    };

    act(() => {
      result.current.updateNodeFromEvent(taskEvent);
    });

    // Nodes should remain unchanged
    expect(result.current.nodes).toEqual(mockNodes);
  });
});
