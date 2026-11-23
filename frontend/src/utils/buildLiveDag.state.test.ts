import { describe, expect, it } from 'vitest';
import type { DAGEvent } from '../types/api';
import {
  applyNodeStates,
  deriveNodeStates,
  edgeExecState,
  isTaskFinished,
  nodeDurationMs,
} from './buildLiveDag';

const ev = (type: DAGEvent['type'], nodeId?: string, seq?: number, payload?: DAGEvent['payload']): DAGEvent => ({
  type,
  taskId: 't1',
  nodeId,
  seq,
  timestamp: `2026-10-19T00:00:0${seq ?? 0}.000Z`,
  payload,
});

const NODES = [{ id: 'research' }, { id: 'coding' }, { id: 'risk' }, { id: 'report' }, { id: 'design' }];

describe('live DAG node state (#818)', () => {
  it('maps fixtures for all 5 node states', () => {
    const events = [
      ev('node_started', 'research', 1),
      ev('node_completed', 'research', 2, { content: 'findings' }),
      ev('node_started', 'coding', 3),
      ev('node_started', 'risk', 4),
      ev('node_failed', 'risk', 5, { error: 'rate limited' }),
    ];
    const live = applyNodeStates(NODES, deriveNodeStates(events));
    expect(live.map((n) => n.exec.state)).toEqual(['completed', 'running', 'failed', 'pending', 'pending']);
    expect(live[0].exec.output).toBe('findings');
    expect(live[2].exec.error).toBe('rate limited');

    const finished = applyNodeStates(NODES, deriveNodeStates(events), {
      taskFinished: isTaskFinished([...events, ev('task_failed', undefined, 6)]),
    });
    expect(finished.map((n) => n.exec.state)).toEqual(['completed', 'running', 'failed', 'skipped', 'skipped']);
  });

  it('applies events in seq order so a late start cannot reopen a finished node', () => {
    const states = deriveNodeStates([ev('node_completed', 'a', 2), ev('node_started', 'a', 1)]);
    expect(states.a.state).toBe('completed');
    expect(nodeDurationMs(states.a)).toBe(1000);
  });

  it('does not mutate the input nodes', () => {
    const nodes = [{ id: 'a' }];
    applyNodeStates(nodes, deriveNodeStates([ev('node_started', 'a', 1)]));
    expect(nodes).toEqual([{ id: 'a' }]);
  });

  it('derives edge states', () => {
    expect(edgeExecState('completed', 'running')).toBe('active');
    expect(edgeExecState('completed', 'completed')).toBe('completed');
    expect(edgeExecState('completed', 'failed')).toBe('failed');
    expect(edgeExecState('pending', 'pending')).toBe('idle');
  });

  it('handles payload variants and events without node ids', () => {
    expect(
      deriveNodeStates([
        ev('node_completed', 'string', 1, 'plain text'),
        ev('node_completed', 'summary', 2, { summary: 'summary text' }),
        ev('node_completed', 'markdown', 3, { markdown: 'markdown text' }),
        ev('node_completed', 'message', 4, { message: 'message text' }),
        ev('node_failed', 'error', 5, { error: 'specific error' }),
        ev('node_failed', 'fallback', 6),
        ev('node_started', undefined, 7),
      ]).string.output,
    ).toBe('plain text');
    expect(deriveNodeStates([ev('node_completed', 'summary', 1, { summary: 'summary text' })]).summary.output).toBe(
      'summary text',
    );
    expect(deriveNodeStates([ev('node_completed', 'markdown', 1, { markdown: 'markdown text' })]).markdown.output).toBe(
      'markdown text',
    );
    expect(deriveNodeStates([ev('node_completed', 'message', 1, { message: 'message text' })]).message.output).toBe(
      'message text',
    );
    expect(deriveNodeStates([ev('node_failed', 'error', 1, { error: 'specific error' })]).error.error).toBe(
      'specific error',
    );
    expect(deriveNodeStates([ev('node_failed', 'fallback', 1)]).fallback.error).toBe('Agent failed');
  });

  it('falls back to arrival order and detects finished tasks', () => {
    const states = deriveNodeStates([
      ev('node_started', 'a'),
      ev('node_completed', 'a'),
    ]);
    expect(states.a.state).toBe('completed');
    expect(isTaskFinished([ev('node_started', 'a', 1), ev('task_completed', undefined, 2)])).toBe(true);
    expect(isTaskFinished([ev('node_started', 'a', 1)])).toBe(false);
  });

  it('skips pending nodes after a finished task and preserves running nodes', () => {
    const states = deriveNodeStates([
      ev('node_started', 'a', 1),
      ev('node_completed', 'b', 2),
    ]);
    const live = applyNodeStates(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      states,
      { taskFinished: true },
    );
    expect(live.map((node) => node.exec.state)).toEqual(['running', 'completed', 'skipped']);
  });

  it('returns no duration for missing or invalid timestamps', () => {
    expect(nodeDurationMs({ state: 'running' })).toBeUndefined();
    expect(nodeDurationMs({
      state: 'completed',
      startedAt: 'invalid',
      endedAt: '2026-10-19T00:00:02.000Z',
    })).toBeUndefined();
    expect(nodeDurationMs({
      state: 'completed',
      startedAt: '2026-10-19T00:00:02.000Z',
      endedAt: '2026-10-19T00:00:01.000Z',
    })).toBeUndefined();
  });
});
