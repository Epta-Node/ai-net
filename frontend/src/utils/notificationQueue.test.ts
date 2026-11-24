import { describe, expect, it } from 'vitest'
import {
  MAX_VISIBLE_TOASTS,
  TOAST_DURATION_MS,
  dismissFromQueue,
  groupByDay,
  markAllRead,
  pruneInbox,
  shouldShowBrowserNotification,
  sortNewestFirst,
  splitToastQueue,
  toastDurationMs,
  toastProgress,
  unreadCount,
  visibleSince,
  type InboxEntry,
} from './notificationQueue'

const toasts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}` }))

describe('toast queue', () => {
  it('shows at most three toasts and queues the rest', () => {
    expect(MAX_VISIBLE_TOASTS).toBe(3)
    const { visible, queued } = splitToastQueue(toasts(4))
    expect(visible.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    expect(queued.map((t) => t.id)).toEqual(['t4'])
  })

  it('shows everything when there are three or fewer', () => {
    expect(splitToastQueue(toasts(2))).toEqual({ visible: toasts(2), queued: [] })
    expect(splitToastQueue([])).toEqual({ visible: [], queued: [] })
  })

  it('brings the fourth toast in when one is dismissed', () => {
    const after = dismissFromQueue(toasts(4), 't2')
    const { visible, queued } = splitToastQueue(after)
    expect(visible.map((t) => t.id)).toEqual(['t1', 't3', 't4'])
    expect(queued).toEqual([])
  })

  it('ignores an unknown id and does not mutate its input', () => {
    const input = toasts(3)
    expect(dismissFromQueue(input, 'nope')).toEqual(input)
    expect(dismissFromQueue(input, 'nope')).not.toBe(input)
    dismissFromQueue(input, 't1')
    expect(input).toHaveLength(3)
  })

  it('accepts a custom limit and clamps a bad one', () => {
    expect(splitToastQueue(toasts(5), 2).visible).toHaveLength(2)
    expect(splitToastQueue(toasts(5), -1).visible).toHaveLength(0)
  })
})

describe('durations', () => {
  it('keeps errors for 10s and success and info for 5s', () => {
    expect(toastDurationMs('error')).toBe(10_000)
    expect(toastDurationMs('success')).toBe(5_000)
    expect(toastDurationMs('info')).toBe(5_000)
    expect(TOAST_DURATION_MS.warning).toBeGreaterThanOrEqual(5_000)
  })
})

describe('toastProgress', () => {
  it('counts down from 1 to 0', () => {
    expect(toastProgress(1_000, 5_000, 1_000)).toBe(1)
    expect(toastProgress(1_000, 5_000, 3_500)).toBe(0.5)
    expect(toastProgress(1_000, 5_000, 6_000)).toBe(0)
  })

  it('stays within 0..1 for clocks that run backwards or far ahead', () => {
    expect(toastProgress(5_000, 5_000, 1_000)).toBe(1)
    expect(toastProgress(0, 5_000, 99_999)).toBe(0)
  })

  it('does not count down a toast that never auto-dismisses', () => {
    expect(toastProgress(0, 0, 50_000)).toBe(1)
  })
})

describe('visibleSince', () => {
  it('starts the clock only for visible toasts and keeps earlier start times', () => {
    const first = visibleSince(toasts(4), {}, 1_000)
    expect(first).toEqual({ t1: 1_000, t2: 1_000, t3: 1_000 })
    const later = visibleSince(dismissFromQueue(toasts(4), 't1'), first, 4_000)
    expect(later).toEqual({ t2: 1_000, t3: 1_000, t4: 4_000 })
  })
})

describe('shouldShowBrowserNotification', () => {
  const base = { permission: 'granted' as const, tabHidden: true }

  it('is on for success and error when granted and the tab is hidden', () => {
    expect(shouldShowBrowserNotification({ ...base, type: 'success' })).toBe(true)
    expect(shouldShowBrowserNotification({ ...base, type: 'error' })).toBe(true)
  })

  it('is off for warning and info', () => {
    expect(shouldShowBrowserNotification({ ...base, type: 'warning' })).toBe(false)
    expect(shouldShowBrowserNotification({ ...base, type: 'info' })).toBe(false)
  })

  it('is off when the tab is visible or permission is not granted', () => {
    expect(shouldShowBrowserNotification({ ...base, type: 'success', tabHidden: false })).toBe(false)
    for (const permission of ['denied', 'default', 'unsupported'] as const) {
      expect(shouldShowBrowserNotification({ type: 'error', permission, tabHidden: true })).toBe(false)
    }
  })
})

describe('inbox', () => {
  const entry = (id: string, timestamp: string, read = false): InboxEntry => ({ id, timestamp, read })

  it('sorts newest first and puts unreadable timestamps last', () => {
    const sorted = sortNewestFirst([entry('old', '2026-11-01T00:00:00Z'), entry('bad', 'nope'), entry('new', '2026-11-20T00:00:00Z')])
    expect(sorted.map((e) => e.id)).toEqual(['new', 'old', 'bad'])
  })

  it('counts unread and clears the badge with markAllRead', () => {
    const list = [entry('a', '2026-11-01T00:00:00Z'), entry('b', '2026-11-02T00:00:00Z', true), entry('c', '2026-11-03T00:00:00Z')]
    expect(unreadCount(list)).toBe(2)
    const read = markAllRead(list)
    expect(unreadCount(read)).toBe(0)
    expect(read.every((e) => e.read)).toBe(true)
    expect(unreadCount(list)).toBe(2)
  })

  it('keeps the newest 50 and drops the oldest', () => {
    const many = Array.from({ length: 60 }, (_, i) => entry(`n${i}`, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()))
    const kept = pruneInbox(many)
    expect(kept).toHaveLength(50)
    expect(kept[0].id).toBe('n59')
    expect(kept.at(-1)?.id).toBe('n10')
    expect(pruneInbox(many, 5)).toHaveLength(5)
  })

  it('groups by local day with Today and Yesterday labels, newest first', () => {
    const now = new Date(2026, 10, 24, 12, 0, 0)
    const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).toISOString()
    const groups = groupByDay(
      [
        entry('t1', at(2026, 10, 24, 8)),
        entry('t2', at(2026, 10, 24, 11)),
        entry('y1', at(2026, 10, 23, 20)),
        entry('old', at(2026, 10, 1)),
        entry('bad', 'nope'),
      ],
      now,
    )
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', '2026-11-01', 'Earlier'])
    expect(groups[0].entries.map((e) => e.id)).toEqual(['t2', 't1'])
    expect(groups[3].entries.map((e) => e.id)).toEqual(['bad'])
  })

  it('returns no groups for an empty inbox', () => {
    expect(groupByDay([])).toEqual([])
  })
})
