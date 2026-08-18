import { renderHook, act } from '@testing-library/react';
import { useTaskOutputs } from './useTaskOutputs';
import type { DAGEvent, DAGNode } from '../types/api';

describe('useTaskOutputs', () => {
  const mockTaskId = 'test-task';

  const mockCompletedNodes: DAGNode[] = [
    {
      nodeId: 'node-research',
      agentType: 'research',
      prompt: 'Research task',
      dependsOn: [],
      status: 'completed',
      result: { summary: 'Research completed successfully' }
    },
    {
      nodeId: 'node-coding',
      agentType: 'coding',
      prompt: 'Coding task',
      dependsOn: ['node-research'],
      status: 'completed',
      result: { content: 'Code generated successfully' }
    },
    {
      nodeId: 'node-report',
      agentType: 'report',
      prompt: 'Report task',
      dependsOn: ['node-coding'],
      status: 'pending'
    }
  ];

  it('should initialize with empty outputs', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    expect(result.current.outputs).toEqual({});
    expect(result.current.finalResult).toBe('');
  });

  it('should initialize outputs from completed nodes', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    act(() => {
      result.current.initializeOutputs(mockCompletedNodes);
    });

    expect(result.current.outputs).toEqual({
      'node-research': 'Research completed successfully',
      'node-coding': 'Code generated successfully'
    });
  });

  it('should update output on node_completed event', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    const completedEvent: DAGEvent = {
      type: 'node_completed',
      taskId: mockTaskId,
      nodeId: 'node-design',
      timestamp: new Date().toISOString(),
      payload: { markdown: '# Design Complete\n\nDesign completed successfully' }
    };

    act(() => {
      result.current.updateOutputFromEvent(completedEvent);
    });

    expect(result.current.outputs['node-design']).toBe('# Design Complete\n\nDesign completed successfully');
  });

  it('should handle different payload formats', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    const testCases = [
      {
        payload: { summary: 'Summary output' },
        expected: 'Summary output'
      },
      {
        payload: { content: 'Content output' },
        expected: 'Content output'
      },
      {
        payload: { markdown: 'Markdown output' },
        expected: 'Markdown output'
      },
      {
        payload: 'String output',
        expected: 'String output'
      }
    ];

    testCases.forEach((testCase, index) => {
      const event: DAGEvent = {
        type: 'node_completed',
        taskId: mockTaskId,
        nodeId: `node-${index}`,
        timestamp: new Date().toISOString(),
        payload: testCase.payload
      };

      act(() => {
        result.current.updateOutputFromEvent(event);
      });

      expect(result.current.outputs[`node-${index}`]).toBe(testCase.expected);
    });
  });

  it('should ignore non-node_completed events', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    act(() => {
      result.current.initializeOutputs(mockCompletedNodes);
    });

    const originalOutputs = { ...result.current.outputs };

    const nonCompletedEvent: DAGEvent = {
      type: 'node_started',
      taskId: mockTaskId,
      nodeId: 'node-test',
      timestamp: new Date().toISOString(),
      payload: { summary: 'This should not be added' }
    };

    act(() => {
      result.current.updateOutputFromEvent(nonCompletedEvent);
    });

    expect(result.current.outputs).toEqual(originalOutputs);
  });

  it('should ignore events without nodeId', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    act(() => {
      result.current.initializeOutputs(mockCompletedNodes);
    });

    const originalOutputs = { ...result.current.outputs };

    const eventWithoutNodeId: DAGEvent = {
      type: 'node_completed',
      taskId: mockTaskId,
      timestamp: new Date().toISOString(),
      payload: { summary: 'This should not be added' }
    };

    act(() => {
      result.current.updateOutputFromEvent(eventWithoutNodeId);
    });

    expect(result.current.outputs).toEqual(originalOutputs);
  });

  it('should get node output correctly', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    act(() => {
      result.current.initializeOutputs(mockCompletedNodes);
    });

    expect(result.current.getNodeOutput('node-research')).toBe('Research completed successfully');
    expect(result.current.getNodeOutput('nonexistent')).toBeUndefined();
  });

  it('should check if node has output', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    act(() => {
      result.current.initializeOutputs(mockCompletedNodes);
    });

    expect(result.current.hasOutput('node-research')).toBe(true);
    expect(result.current.hasOutput('node-report')).toBe(false);
    expect(result.current.hasOutput('nonexistent')).toBe(false);
  });

  it('should get completed outputs count', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    act(() => {
      result.current.initializeOutputs(mockCompletedNodes);
    });

    expect(result.current.getCompletedOutputsCount()).toBe(2);
  });

  it('should get all outputs as array', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    act(() => {
      result.current.initializeOutputs(mockCompletedNodes);
    });

    const outputsArray = result.current.getOutputsArray();
    expect(outputsArray).toHaveLength(2);
    expect(outputsArray).toContainEqual({
      nodeId: 'node-research',
      output: 'Research completed successfully'
    });
    expect(outputsArray).toContainEqual({
      nodeId: 'node-coding',
      output: 'Code generated successfully'
    });
  });

  it('should generate final result for single output', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    act(() => {
      result.current.initializeOutputs([mockCompletedNodes[0]]);
    });

    expect(result.current.finalResult).toBe('Research completed successfully');
  });

  it('should generate final result for multiple outputs', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    act(() => {
      result.current.initializeOutputs(mockCompletedNodes);
    });

    const expectedResult = `## Research Agent Output

Research completed successfully

---

## Coding Agent Output

Code generated successfully`;

    expect(result.current.finalResult).toBe(expectedResult);
  });

  it('should handle empty output text', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    const eventWithEmptyOutput: DAGEvent = {
      type: 'node_completed',
      taskId: mockTaskId,
      nodeId: 'node-empty',
      timestamp: new Date().toISOString(),
      payload: { summary: '' }
    };

    act(() => {
      result.current.updateOutputFromEvent(eventWithEmptyOutput);
    });

    // Since JSON.stringify of the payload occurs, and the result has content, it will be added
    expect(result.current.outputs['node-empty']).toBe('{"summary":""}');
  });

  it('should handle complex object payloads by falling back to JSON stringify', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    const complexPayload = {
      data: { nested: 'value' },
      list: [1, 2, 3],
      boolean: true
    };

    const eventWithComplexPayload: DAGEvent = {
      type: 'node_completed',
      taskId: mockTaskId,
      nodeId: 'node-complex',
      timestamp: new Date().toISOString(),
      payload: complexPayload
    };

    act(() => {
      result.current.updateOutputFromEvent(eventWithComplexPayload);
    });

    expect(result.current.outputs['node-complex']).toBe(JSON.stringify(complexPayload));
  });

  it('should initialize from nodes with different result formats', () => {
    const { result } = renderHook(() => useTaskOutputs(mockTaskId));

    const mixedNodes: DAGNode[] = [
      {
        nodeId: 'node-1',
        agentType: 'test',
        prompt: 'Test',
        dependsOn: [],
        status: 'completed',
        result: 'String result'
      },
      {
        nodeId: 'node-2',
        agentType: 'test',
        prompt: 'Test',
        dependsOn: [],
        status: 'completed',
        result: { markdown: 'Markdown result' }
      },
      {
        nodeId: 'node-3',
        agentType: 'test',
        prompt: 'Test',
        dependsOn: [],
        status: 'completed',
        result: { data: 'complex' }
      }
    ];

    act(() => {
      result.current.initializeOutputs(mixedNodes);
    });

    expect(result.current.outputs['node-1']).toBe('String result');
    expect(result.current.outputs['node-2']).toBe('Markdown result');
    expect(result.current.outputs['node-3']).toBe('{"data":"complex"}');
  });
});
