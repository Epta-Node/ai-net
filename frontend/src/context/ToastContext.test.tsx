/**
 * Tests for ToastContext — Issue #630
 *
 * Acceptance criteria verified here:
 *  AC1: No state updater mutates a variable in an enclosing scope
 *       (behavioural consequence: duplicate grouping works correctly in StrictMode)
 *  AC2: Firing the same message twice yields a single toast with count: 2
 *  AC3: The grouped toast still auto-dismisses after its duration
 *  AC4: Behaviour is identical under StrictMode double-invocation
 */
import { render, screen, act, waitFor } from '@testing-library/react'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import React, { useRef } from 'react'
import { ToastProvider, useToast } from './ToastContext'
import type { ToastContextValue } from './ToastContext'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * A test consumer that exposes the toast context and lets tests call
 * showToast imperatively via a forwarded ref.
 */
const TestConsumer = React.forwardRef<ToastContextValue>((_, ref) => {
  const ctx = useToast()

  // Forward the ctx so the test can call showToast directly.
  React.useImperativeHandle(ref, () => ctx, [ctx])

  return (
    <div>
      <div data-testid="toast-count">{ctx.toasts.length}</div>
      <div data-testid="toasts-json">{JSON.stringify(ctx.toasts)}</div>
    </div>
  )
})

TestConsumer.displayName = 'TestConsumer'

function setup() {
  const ref = React.createRef<ToastContextValue>()
  render(
    <ToastProvider>
      <TestConsumer ref={ref} />
    </ToastProvider>,
  )
  return ref
}

function getToasts(): ReturnType<typeof JSON.parse> {
  return JSON.parse(screen.getByTestId('toasts-json').textContent ?? '[]')
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('ToastContext (Issue #630)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('shows a single toast on first call', () => {
    const ref = setup()

    act(() => {
      ref.current!.showToast('Hello world', 'info', 0)
    })

    expect(screen.getByTestId('toast-count').textContent).toBe('1')
    expect(getToasts()[0].message).toBe('Hello world')
    expect(getToasts()[0].count).toBe(1)
  })

  test('AC2 — firing the same message twice yields a single toast with count: 2', () => {
    const ref = setup()

    act(() => {
      ref.current!.showToast('Hello world', 'info', 0)
    })

    act(() => {
      ref.current!.showToast('Hello world', 'info', 0)
    })

    // Still only one visible toast
    expect(screen.getByTestId('toast-count').textContent).toBe('1')
    // count incremented to 2
    expect(getToasts()[0].count).toBe(2)
  })

  test('different message does NOT group — produces two toasts', () => {
    const ref = setup()

    act(() => {
      ref.current!.showToast('Message A', 'info', 0)
    })

    act(() => {
      ref.current!.showToast('Message B', 'info', 0)
    })

    expect(screen.getByTestId('toast-count').textContent).toBe('2')
  })

  test('same message, different type does NOT group — produces two toasts', () => {
    const ref = setup()

    act(() => {
      ref.current!.showToast('Hello world', 'info', 0)
    })

    act(() => {
      ref.current!.showToast('Hello world', 'error', 0)
    })

    expect(screen.getByTestId('toast-count').textContent).toBe('2')
  })

  test('AC4 — duplicate grouping works under StrictMode', () => {
    // StrictMode double-invokes state updaters — the fix must be idempotent
    const ref = React.createRef<ToastContextValue>()
    render(
      <React.StrictMode>
        <ToastProvider>
          <TestConsumer ref={ref} />
        </ToastProvider>
      </React.StrictMode>,
    )

    act(() => {
      ref.current!.showToast('Hello world', 'info', 0)
    })

    act(() => {
      ref.current!.showToast('Hello world', 'info', 0)
    })

    // Must still be 1 toast with count 2, not 2 toasts
    expect(screen.getByTestId('toast-count').textContent).toBe('1')
    expect(getToasts()[0].count).toBe(2)
  })

  test('AC3 — grouped toast auto-dismisses after its duration', async () => {
    const ref = setup()

    // Show the same toast twice with a short auto-dismiss timer (100 ms)
    act(() => {
      ref.current!.showToast('Timer toast', 'success', 100)
    })

    act(() => {
      ref.current!.showToast('Timer toast', 'success', 100)
    })

    expect(screen.getByTestId('toast-count').textContent).toBe('1')
    expect(getToasts()[0].count).toBe(2)

    // Advance past the dismiss timer
    act(() => {
      vi.advanceTimersByTime(200)
    })

    await waitFor(() => {
      expect(screen.getByTestId('toast-count').textContent).toBe('0')
    })
  })

  test('empty message is ignored', () => {
    const ref = setup()

    act(() => {
      ref.current!.showToast('   ', 'info', 0)
    })

    expect(screen.getByTestId('toast-count').textContent).toBe('0')
  })
})
