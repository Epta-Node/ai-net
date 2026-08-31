import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyMatchFields } from './fuzzy';

/** Score a match, or `-Infinity` when the query does not match at all. */
const score = (query: string, target: string) => fuzzyMatch(query, target)?.score ?? -Infinity;

describe('fuzzyMatch — what matches', () => {
  it('matches an exact string', () => {
    expect(fuzzyMatch('wallet', 'Wallet')).not.toBeNull();
  });

  it('matches a prefix', () => {
    expect(fuzzyMatch('dash', 'Dashboard')).not.toBeNull();
  });

  it('matches a non-contiguous subsequence — the point of fuzzy search', () => {
    expect(fuzzyMatch('dsh', 'Dashboard')).not.toBeNull();
    expect(fuzzyMatch('tnw', 'Task: New')).not.toBeNull();
    expect(fuzzyMatch('cpad', 'Copy wallet address')).not.toBeNull();
  });

  it('is case-insensitive in both directions', () => {
    expect(fuzzyMatch('WALLET', 'wallet')).not.toBeNull();
    expect(fuzzyMatch('wallet', 'WALLET')).not.toBeNull();
  });

  it('ignores surrounding whitespace in the query', () => {
    expect(fuzzyMatch('  dash  ', 'Dashboard')).not.toBeNull();
  });

  it('rejects characters that are absent', () => {
    expect(fuzzyMatch('xyz', 'Dashboard')).toBeNull();
  });

  it('rejects characters that are present but out of order', () => {
    // Every letter of "hsad" is in "Dashboard", but not in that sequence.
    expect(fuzzyMatch('hsad', 'Dashboard')).toBeNull();
  });

  it('rejects a query longer than the target', () => {
    expect(fuzzyMatch('dashboards-and-more', 'Dash')).toBeNull();
  });

  it('treats an empty query as a zero-score match, not a rejection', () => {
    expect(fuzzyMatch('', 'Dashboard')).toEqual({ score: 0, indices: [] });
  });

  it('handles an empty target without throwing', () => {
    expect(fuzzyMatch('a', '')).toBeNull();
  });
});

describe('fuzzyMatch — ranking', () => {
  it('ranks an exact match above a prefix match', () => {
    expect(score('wallet', 'Wallet')).toBeGreaterThan(score('wallet', 'Wallet settings'));
  });

  it('ranks a prefix above a match starting mid-string', () => {
    expect(score('task', 'Task history')).toBeGreaterThan(score('task', 'Run new task'));
  });

  it('ranks consecutive characters above scattered ones', () => {
    expect(score('new', 'New task')).toBeGreaterThan(score('new', 'Network stats view'));
  });

  it('rewards matching the start of a word', () => {
    // `nt` as two word-initials beats `nt` buried inside one word.
    expect(score('nt', 'New task')).toBeGreaterThan(score('nt', 'Nightly'));
  });

  it('rewards camelCase humps as word starts', () => {
    expect(score('rt', 'RecentTasks')).toBeGreaterThan(score('rt', 'Rooted'));
  });

  it('penalises a long unmatched prefix', () => {
    expect(score('x', 'xylophone')).toBeGreaterThan(score('x', 'aaaaaaaaaax'));
  });

  it('caps the leading penalty so a deep match is still findable', () => {
    expect(fuzzyMatch('x', 'a'.repeat(200) + 'x')).not.toBeNull();
  });
});

describe('fuzzyMatch — highlight indices', () => {
  it('reports the index of every matched character, ascending', () => {
    const match = fuzzyMatch('dsh', 'Dashboard');
    expect(match).not.toBeNull();
    expect(match!.indices).toHaveLength(3);
    expect([...match!.indices].sort((a, b) => a - b)).toEqual(match!.indices);
  });

  it('reports indices that actually spell the query in the target', () => {
    const target = 'Copy wallet address';
    const match = fuzzyMatch('cpad', target)!;
    const spelled = match.indices.map((i) => target[i].toLowerCase()).join('');
    expect(spelled).toBe('cpad');
  });

  it('anchors a prefix match at index 0', () => {
    expect(fuzzyMatch('dash', 'Dashboard')!.indices).toEqual([0, 1, 2, 3]);
  });
});

describe('fuzzyMatchFields', () => {
  const fields = (title: string, subtitle: string) => [
    { text: title, weight: 1 },
    { text: subtitle, weight: 0.5 },
  ];

  it('returns null when no field matches', () => {
    expect(fuzzyMatchFields('zzz', fields('Wallet', 'Manage funds'))).toBeNull();
  });

  it('reports which field produced the winning score', () => {
    const match = fuzzyMatchFields('wallet', fields('Wallet', 'Manage funds'));
    expect(match?.fieldIndex).toBe(0);
  });

  it('falls back to a lower-weighted field when only that one matches', () => {
    const match = fuzzyMatchFields('funds', fields('Wallet', 'Manage funds'));
    expect(match?.fieldIndex).toBe(1);
  });

  it('prefers the higher-weighted field when both match equally well', () => {
    const match = fuzzyMatchFields('abc', fields('abc', 'abc'));
    expect(match?.fieldIndex).toBe(0);
  });

  it('skips empty and missing fields rather than throwing', () => {
    const match = fuzzyMatchFields('abc', [
      { text: undefined, weight: 1 },
      { text: '', weight: 1 },
      { text: 'abc', weight: 1 },
    ]);
    expect(match?.fieldIndex).toBe(2);
  });
});
