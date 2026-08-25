import { describe, test, expect } from 'vitest';
import { formatRelativeTime } from './time';

describe('formatRelativeTime', () => {
  test('returns "Just now" for recent or empty dates', () => {
    expect(formatRelativeTime('')).toBe('Just now');
    expect(formatRelativeTime('invalid-date')).toBe('Just now');
    expect(formatRelativeTime(new Date().toISOString())).toBe('Just now');
    expect(formatRelativeTime(Date.now() - 3000)).toBe('Just now');
  });

  test('returns seconds ago for diff under 60 seconds', () => {
    const thirtySecsAgo = Date.now() - 30000;
    expect(formatRelativeTime(thirtySecsAgo)).toBe('30s ago');
  });

  test('returns minutes ago for diff under 60 minutes', () => {
    const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
    expect(formatRelativeTime(fiveMinsAgo)).toBe('5m ago');
  });

  test('returns hours ago for diff under 24 hours', () => {
    const threeHoursAgo = Date.now() - 3 * 3600 * 1000;
    expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago');
  });

  test('returns days ago for diff under 7 days', () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 3600 * 1000;
    expect(formatRelativeTime(twoDaysAgo)).toBe('2d ago');
  });
});
