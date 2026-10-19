import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionTimer } from './walletSession'

describe('SessionTimer (#828)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires warning callback at sessionTtlMs - warningBeforeExpiryMs', () => {
    const onWarning = vi.fn()
    const timer = new SessionTimer({ sessionTtlMs: 10_000, warningBeforeExpiryMs: 2_000 })
    timer.onWarning(onWarning)
    timer.start()

    vi.advanceTimersByTime(7_999)
    expect(onWarning).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onWarning).toHaveBeenCalledOnce()

    timer.stop()
  })

  it('fires expiry callback at sessionTtlMs', () => {
    const onExpiry = vi.fn()
    const timer = new SessionTimer({ sessionTtlMs: 5_000, warningBeforeExpiryMs: 1_000 })
    timer.onExpiry(onExpiry)
    timer.start()

    vi.advanceTimersByTime(4_999)
    expect(onExpiry).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onExpiry).toHaveBeenCalledOnce()
  })

  it('extendSession resets the expiry clock', () => {
    const onExpiry = vi.fn()
    const timer = new SessionTimer({ sessionTtlMs: 5_000, warningBeforeExpiryMs: 1_000 })
    timer.onExpiry(onExpiry)
    timer.start()

    vi.advanceTimersByTime(4_000)
    timer.extendSession()
    vi.advanceTimersByTime(4_999)
    expect(onExpiry).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onExpiry).toHaveBeenCalledOnce()

    timer.stop()
  })

  it('getTimeUntilExpiry decreases over time', () => {
    const timer = new SessionTimer({ sessionTtlMs: 10_000, warningBeforeExpiryMs: 2_000 })
    timer.start()

    const initial = timer.getTimeUntilExpiry()
    vi.advanceTimersByTime(3_000)
    const later = timer.getTimeUntilExpiry()

    expect(initial).toBeGreaterThan(later)
    expect(later).toBeLessThanOrEqual(7_000)

    timer.stop()
  })

  it('getTimeUntilExpiry returns 0 when not running', () => {
    const timer = new SessionTimer({ sessionTtlMs: 5_000, warningBeforeExpiryMs: 1_000 })
    expect(timer.getTimeUntilExpiry()).toBe(0)
  })

  it('throttles activity: 10 rapid clicks extend only once', () => {
    const onExpiry = vi.fn()
    const timer = new SessionTimer({
      sessionTtlMs: 5_000,
      warningBeforeExpiryMs: 1_000,
      extensionThrottleMs: 30_000,
    })
    timer.onExpiry(onExpiry)
    timer.start()

    vi.advanceTimersByTime(4_500)

    // Simulate 10 rapid activity events — none should extend because
    // extensionThrottleMs has not elapsed since start.
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event('click'))
    }

    // Would expire at 5_000; still within that window
    vi.advanceTimersByTime(600)
    expect(onExpiry).toHaveBeenCalledOnce()

    timer.stop()
  })

  it('does not fire after stop()', () => {
    const onWarning = vi.fn()
    const onExpiry = vi.fn()
    const timer = new SessionTimer({ sessionTtlMs: 5_000, warningBeforeExpiryMs: 1_000 })
    timer.onWarning(onWarning).onExpiry(onExpiry)
    timer.start()
    timer.stop()

    vi.advanceTimersByTime(10_000)
    expect(onWarning).not.toHaveBeenCalled()
    expect(onExpiry).not.toHaveBeenCalled()
  })

  it('extendSession resets the warning clock', () => {
    const onWarning = vi.fn()
    const timer = new SessionTimer({ sessionTtlMs: 10_000, warningBeforeExpiryMs: 2_000 })
    timer.onWarning(onWarning)
    timer.start()

    vi.advanceTimersByTime(7_500)
    timer.extendSession()

    // Warning should NOT have fired yet — the clock reset
    vi.advanceTimersByTime(7_999)
    expect(onWarning).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onWarning).toHaveBeenCalledOnce()

    timer.stop()
  })
})
