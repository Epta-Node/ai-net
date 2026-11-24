// Pure rules behind the toast queue and notification center (issue #1014):
// how many toasts show at once, how long each type stays, the countdown
// progress, when a browser notification is allowed, and how the inbox groups
// entries by day. No React, DOM or timers here, so each rule is testable with
// plain values. ToastContext and NotificationCenter call into these.

export type NotificationType = 'success' | 'error' | 'warning' | 'info'

/** At most this many toasts are on screen; the rest wait their turn. */
export const MAX_VISIBLE_TOASTS = 3

/** Auto-dismiss time per type: errors stay twice as long as the rest. */
export const TOAST_DURATION_MS: Record<NotificationType, number> = {
  success: 5_000,
  info: 5_000,
  warning: 7_000,
  error: 10_000,
}

export const toastDurationMs = (type: NotificationType): number => TOAST_DURATION_MS[type]

export interface QueuedToast {
  id: string
}

/** Oldest first: the first MAX_VISIBLE_TOASTS are shown and the rest queue behind them. */
export function splitToastQueue<T extends QueuedToast>(
  toasts: readonly T[],
  maxVisible: number = MAX_VISIBLE_TOASTS,
): { visible: T[]; queued: T[] } {
  const limit = Math.max(0, Math.floor(maxVisible))
  return { visible: toasts.slice(0, limit), queued: toasts.slice(limit) }
}

/**
 * Removes one toast. The queue is a single ordered list, so the next waiting
 * toast moves into the visible window by itself; an unknown id changes nothing.
 */
export function dismissFromQueue<T extends QueuedToast>(toasts: readonly T[], id: string): T[] {
  return toasts.some((t) => t.id === id) ? toasts.filter((t) => t.id !== id) : [...toasts]
}

/**
 * Countdown for a toast's progress bar: 1 when it appears, 0 when it expires.
 * A toast that never auto-dismisses (duration <= 0) stays at 1.
 */
export function toastProgress(shownAtMs: number, durationMs: number, nowMs: number): number {
  if (durationMs <= 0) return 1
  const elapsed = Math.max(0, nowMs - shownAtMs)
  return Math.min(1, Math.max(0, 1 - elapsed / durationMs))
}

/**
 * The visible window starts the clock only when a toast becomes visible, so a
 * queued toast does not use up its time while it waits. Returns the time
 * each toast should be treated as shown at.
 */
export function visibleSince(
  toasts: readonly QueuedToast[],
  previous: Readonly<Record<string, number>>,
  nowMs: number,
  maxVisible: number = MAX_VISIBLE_TOASTS,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const toast of toasts.slice(0, Math.max(0, Math.floor(maxVisible)))) {
    out[toast.id] = previous[toast.id] ?? nowMs
  }
  return out
}

export type BrowserPermission = 'granted' | 'denied' | 'default' | 'unsupported'

/**
 * Whether to also show a browser notification: only for success and error,
 * only when the user granted permission, and only when the tab is hidden, so
 * someone looking at the app is not told twice.
 */
export function shouldShowBrowserNotification(opts: {
  type: NotificationType
  permission: BrowserPermission
  tabHidden: boolean
}): boolean {
  return opts.permission === 'granted' && opts.tabHidden && (opts.type === 'success' || opts.type === 'error')
}

export interface InboxEntry {
  id: string
  timestamp: string | number | Date
  read: boolean
}

/** Newest first; entries with an unreadable timestamp sort last. */
export function sortNewestFirst<T extends InboxEntry>(entries: readonly T[]): T[] {
  const time = (e: T) => {
    const t = new Date(e.timestamp).getTime()
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t
  }
  return [...entries].sort((a, b) => time(b) - time(a))
}

export const unreadCount = (entries: readonly InboxEntry[]): number => entries.filter((e) => !e.read).length

export const markAllRead = <T extends InboxEntry>(entries: readonly T[]): T[] =>
  entries.map((e) => (e.read ? e : { ...e, read: true }))

/** Keeps the newest `max` entries (default 50), dropping the oldest. */
export function pruneInbox<T extends InboxEntry>(entries: readonly T[], max: number = 50): T[] {
  return sortNewestFirst(entries).slice(0, Math.max(0, Math.floor(max)))
}

export interface DayGroup<T> {
  /** "Today", "Yesterday", or the calendar date as YYYY-MM-DD. */
  label: string
  entries: T[]
}

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Groups entries by local calendar day, newest group and newest entry first. */
export function groupByDay<T extends InboxEntry>(entries: readonly T[], now: Date = new Date()): DayGroup<T>[] {
  const today = dayKey(now)
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const groups = new Map<string, DayGroup<T>>()
  for (const entry of sortNewestFirst(entries)) {
    const date = new Date(entry.timestamp)
    const key = Number.isNaN(date.getTime()) ? 'unknown' : dayKey(date)
    const label = key === today ? 'Today' : key === yesterday ? 'Yesterday' : key === 'unknown' ? 'Earlier' : key
    const group = groups.get(key) ?? { label, entries: [] }
    group.entries.push(entry)
    groups.set(key, group)
  }
  return [...groups.values()]
}
