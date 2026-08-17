import { useState, useCallback, useMemo } from 'react';
import type { DAGEvent, DAGNode } from '../types/api';

export const useTaskOutputs = (_taskId: string) => {
  const [outputs, setOutputs] = useState<Record<string, string>>({});

  const updateOutputFromEvent = useCallback((event: DAGEvent) => {
    if (!event.nodeId || event.type !== 'node_completed') return;

    const payload = event.payload as any;
    let outputText = payload?.summary || payload?.content || payload?.markdown;
    
    if (!outputText && typeof payload === 'string') {
      outputText = payload;
    } else if (!outputText && payload !== null && payload !== undefined) {
      outputText = JSON.stringify(payload);
    }

    if (outputText && outputText.trim().length > 0) {
      setOutputs(prev => ({
        ...prev,
        [event.nodeId!]: outputText
      }));
    }
  }, []);

  const getNodeOutput = useCallback((nodeId: string): string | undefined => {
    return outputs[nodeId];
  }, [outputs]);

  const getAllOutputs = useCallback((): Record<string, string> => {
    return outputs;
  }, [outputs]);

  const getOutputsArray = useCallback((): Array<{nodeId: string, output: string}> => {
    return Object.entries(outputs).map(([nodeId, output]) => ({
      nodeId,
      output
    }));
  }, [outputs]);

  const finalResult = useMemo((): string => {
    // Concatenate all outputs in order
    const outputEntries = Object.entries(outputs);
    if (outputEntries.length === 0) return '';
    
    // If there's only one output, return it directly
    if (outputEntries.length === 1) {
      return outputEntries[0][1];
    }
    
    // For multiple outputs, combine them with headers
    return outputEntries
      .map(([nodeId, output]) => {
        const agentType = nodeId.replace('node_', '').replace('node-', '');
        return `## ${agentType.charAt(0).toUpperCase() + agentType.slice(1)} Agent Output\n\n${output}`;
      })
      .join('\n\n---\n\n');
  }, [outputs]);

  const initializeOutputs = useCallback((completedNodes: DAGNode[]) => {
    const initialOutputs: Record<string, string> = {};
    
    completedNodes.forEach(node => {
      if (node.status === 'completed' && node.result) {
        const res = node.result as any;
        const outputText = res.summary || 
                          res.content || 
                          res.markdown || 
                          (typeof res === 'string' ? res : JSON.stringify(res));
        if (outputText) {
          initialOutputs[node.nodeId] = outputText;
        }
      }
    });
    
    setOutputs(initialOutputs);
  }, []);

  const hasOutput = useCallback((nodeId: string): boolean => {
    return nodeId in outputs && outputs[nodeId].trim().length > 0;
  }, [outputs]);

  const getCompletedOutputsCount = useCallback((): number => {
    return Object.keys(outputs).length;
  }, [outputs]);

  return {
    outputs,
    finalResult,
    updateOutputFromEvent,
    getNodeOutput,
    getAllOutputs,
    getOutputsArray,
    hasOutput,
    getCompletedOutputsCount,
    initializeOutputs,
  };
};
