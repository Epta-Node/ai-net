/**
 * Tests for useWalletBalance — issue #637
 *
 * Acceptance criteria verified here:
 *  AC1: Changing the wallet triggers an immediate refetch (new address is requested
 *       without waiting for POLL_INTERVAL).
 *  AC2: No ref is mutated during the render phase (publicKey is passed directly to
 *       useCallback, not via a ref — tested by asserting the first fetch after a
 *       wallet switch uses the new key).
 *  AC3: The previous wallet's data is cleared while the new address loads (balance
 *       resets to '0' and loading becomes true before the new fetch resolves).
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useWalletBalance } from './useWalletBalance'

const WALLET_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
const WALLET_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

const makeAccountResponse = (xlmBalance: string) => ({
  balances: [
    { asset_type: 'native', balance: xlmBalance },
    { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER', balance: '10.0000000' },
  ],
})

describe('useWalletBalance', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches balance for the initial wallet key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(makeAccountResponse('100.0000000')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const { result } = renderHook(() => useWalletBalance(WALLET_A))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.balance).toBe('100.0000000')
    expect(result.current.error).toBeNull()
  })

  it('returns zero balance and no error when publicKey is null', async () => {
    const { result } = renderHook(() => useWalletBalance(null))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.balance).toBe('0')
    expect(result.current.balances).toEqual([])
    expect(result.current.error).toBeNull()
  })

  // AC3 — previous wallet data cleared immediately on switch
  it('clears stale balance and sets loading=true immediately when wallet changes (AC3)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(makeAccountResponse('100.0000000')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) => useWalletBalance(key),
      { initialProps: { key: WALLET_A } }
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.balance).toBe('100.0000000')

    // Block the next fetch so we can inspect the intermediate cleared state.
    let resolveNewFetch!: (r: Response) => void
    fetchSpy.mockReturnValueOnce(
      new Promise<Response>((res) => {
        resolveNewFetch = res
      })
    )

    act(() => {
      rerender({ key: WALLET_B })
    })

    // Data from WALLET_A must be cleared immediately, before the fetch resolves.
    expect(result.current.balance).toBe('0')
    expect(result.current.balances).toEqual([])
    expect(result.current.loading).toBe(true)

    // Unblock and verify the new fetch resolves correctly.
    await act(async () => {
      resolveNewFetch(
        new Response(JSON.stringify(makeAccountResponse('50.0000000')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.balance).toBe('50.0000000')
  })

  // AC1 — wallet switch triggers immediate refetch (doesn't wait for the interval)
  it('refetches immediately on wallet switch without waiting for POLL_INTERVAL (AC1)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(makeAccountResponse('100.0000000')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useWalletBalance(key),
      { initialProps: { key: WALLET_A } }
    )

    await waitFor(() => expect(result.current.loading).toBe(false))

    const callsAfterFirstLoad = fetchSpy.mock.calls.length

    // Switch wallet — new fetch should happen without advancing timers.
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(makeAccountResponse('42.0000000')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    act(() => {
      rerender({ key: WALLET_B })
    })

    await waitFor(() => expect(result.current.loading).toBe(false))

    // A new fetch must have fired; the URL must reference WALLET_B.
    const newCalls = fetchSpy.mock.calls.slice(callsAfterFirstLoad)
    expect(newCalls.length).toBeGreaterThanOrEqual(1)
    const newFetchUrl = newCalls[0][0] as string
    expect(newFetchUrl).toContain(WALLET_B)
    expect(result.current.balance).toBe('42.0000000')
  })

  // AC1 — the new address is requested, not the old one
  it('requests the new wallet address, not the previous one, after a switch (AC1/AC2)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeAccountResponse('100.0000000')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeAccountResponse('77.0000000')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useWalletBalance(key),
      { initialProps: { key: WALLET_A } }
    )

    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => rerender({ key: WALLET_B }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    const urls = fetchSpy.mock.calls.map((c) => c[0] as string)
    expect(urls.some((u) => u.includes(WALLET_B))).toBe(true)
    expect(result.current.balance).toBe('77.0000000')
  })

  it('handles a 404 response by returning zero balance and no error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 })
    )

    const { result } = renderHook(() => useWalletBalance(WALLET_A))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.balance).toBe('0')
    expect(result.current.error).toBeNull()
  })

  it('sets error on non-404 Horizon failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('server error', { status: 500 })
    )

    const { result } = renderHook(() => useWalletBalance(WALLET_A))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toMatch(/Horizon error: 500/)
  })

  it('polls at POLL_INTERVAL after initial fetch', async () => {
    // Use fake timers but allow Date/setTimeout to advance automatically so
    // waitFor (which relies on real setTimeout internally) still functions.
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(makeAccountResponse('100.0000000')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const { result } = renderHook(() => useWalletBalance(WALLET_A))

    await waitFor(() => expect(result.current.loading).toBe(false))

    const callsBefore = fetchSpy.mock.calls.length

    // Advance by one full poll interval to trigger the setInterval callback
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })

    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore))

    vi.useRealTimers()
  })

  it('calculates reservedXLM and availableXLM correctly (#822)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          balances: [{ asset_type: 'native', balance: '50.0000000' }],
          subentry_count: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const { result } = renderHook(() =>
      useWalletBalance({ publicKey: WALLET_A, pollIntervalMs: 5000 })
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.balanceXLM).toBe('50.0000000')
    // (2 + 2) * 0.5 = 2.0000000
    expect(result.current.reservedXLM).toBe('2.0000000')
    expect(result.current.availableXLM).toBe('48.0000000')
    expect(result.current.lastUpdatedAt).toBeInstanceOf(Date)
  })

  it('triggers immediate refetch when refresh() is called (#822)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(makeAccountResponse('100.0000000')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const { result } = renderHook(() =>
      useWalletBalance({ publicKey: WALLET_A, pollIntervalMs: 60_000 })
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const callsBefore = fetchSpy.mock.calls.length

    act(() => {
      result.current.refresh()
    })

    await waitFor(() => expect(fetchSpy.mock.calls.length).toBe(callsBefore + 1))
  })

  it('pauses polling when document visibilityState is hidden (#822)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(makeAccountResponse('100.0000000')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    })

    const { result } = renderHook(() =>
      useWalletBalance({ publicKey: WALLET_A, pollIntervalMs: 5000, pauseWhenHidden: true })
    )

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const callsBefore = fetchSpy.mock.calls.length

    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })

    // Should not poll while hidden
    expect(fetchSpy.mock.calls.length).toBe(callsBefore)

    // Becoming visible triggers immediate resume
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() => expect(fetchSpy.mock.calls.length).toBe(callsBefore + 1))

    vi.useRealTimers()
  })
})

