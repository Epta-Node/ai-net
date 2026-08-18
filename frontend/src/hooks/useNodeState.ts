import { useState, useCallback } from 'react';
import type { DAGNode, DAGEvent, NodeStatus } from '../types/api';

export const useNodeState = (_taskId: string) => {
  const [nodes, setNodes] = useState<DAGNode[]>([]);

  const updateNodeFromEvent = useCallback((event: DAGEvent) => {
    if (!event.nodeId) return;

    setNodes(prev => {
      switch (event.type) {
        case 'node_started':
          return prev.map(n => 
            n.nodeId === event.nodeId ? { ...n, status: 'running' } : n
          );

        case 'node_completed':
          const payload = event.payload as any;
          return prev.map(n => 
            n.nodeId === event.nodeId 
              ? { ...n, status: 'completed', result: payload } 
              : n
          );

        case 'node_failed':
          const errMessage = (event.payload as any)?.error || 'Node execution failed';
          return prev.map(n => 
            n.nodeId === event.nodeId 
              ? { ...n, status: 'failed', error: errMessage } 
              : n
          );

        default:
          return prev;
      }
    });
  }, []);

  const getNodeStatus = useCallback((nodeId: string): NodeStatus | undefined => {
    const node = nodes.find(n => n.nodeId === nodeId);
    return node?.status;
  }, [nodes]);

  const getCompletedNodes = useCallback((): DAGNode[] => {
    return nodes.filter(n => n.status === 'completed');
  }, [nodes]);

  const getRunningNodes = useCallback((): DAGNode[] => {
    return nodes.filter(n => n.status === 'running');
  }, [nodes]);

  const getFailedNodes = useCallback((): DAGNode[] => {
    return nodes.filter(n => n.status === 'failed');
  }, [nodes]);

  const initializeNodes = useCallback((initialNodes: DAGNode[]) => {
    setNodes(initialNodes);
  }, []);

  const getNodeById = useCallback((nodeId: string): DAGNode | undefined => {
    return nodes.find(n => n.nodeId === nodeId);
  }, [nodes]);

  return {
    nodes,
    updateNodeFromEvent,
    getNodeStatus,
    getCompletedNodes,
    getRunningNodes,
    getFailedNodes,
    getNodeById,
    initializeNodes,
  };
};
