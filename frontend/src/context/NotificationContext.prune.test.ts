import { describe, expect, it } from 'vitest';
import { MAX_NOTIFICATIONS, pruneNotifications } from './NotificationContext';
import type { AppNotification } from '../types/notification';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function make(id: string, ageMs: number): AppNotification {
  return {
    id,
    type: 'task_completed',
    title: id,
    message: '',
    timestamp: new Date(NOW - ageMs).toISOString(),
    read: false,
  };
}

describe('pruneNotifications', () => {
  it('drops notifications older than 7 days', () => {
    const result = pruneNotifications([make('fresh', DAY), make('edge', 7 * DAY), make('old', 8 * DAY)], NOW);
    expect(result.map((n) => n.id)).toEqual(['fresh', 'edge']);
  });

  it('keeps only the newest 100', () => {
    const list = Array.from({ length: 120 }, (_, i) => make(`n${i}`, i * 1000));
    const result = pruneNotifications(list, NOW);
    expect(result).toHaveLength(MAX_NOTIFICATIONS);
    expect(result[0].id).toBe('n0');
  });

  it('keeps entries whose timestamp cannot be read', () => {
    const broken = { ...make('broken', 0), timestamp: 'not a date' };
    expect(pruneNotifications([broken], NOW)).toHaveLength(1);
  });
});
