/**
 * Tests for useTransactionHistory — issue #637
 *
 * Acceptance criteria verified here:
 *  AC1: Changing the wallet triggers an immediate refetch (new address is requested
 *       without waiting for REFRESH_INTERVAL).
 *  AC2: No ref is mutated during the render phase (publicKey is passed directly to
 *       useCallback — tested by asserting the fetch URL after a wallet switch).
 *  AC3: The previous wallet's transactions are cleared while the new address loads.
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useTransactionHistory } from './useTransactionHistory'

const WALLET_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
const WALLET_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

function makePaymentsResponse(fromKey: string, txHashes: string[]) {
  return {
    _embedded: {
      records: txHashes.map((hash, i) => ({
        type: 'payment',
        amount: '10.0000000',
        from: fromKey,
        to: 'GCOUNTERPARTY',
        transaction_hash: hash,
        created_at: `2024-01-0${i + 1}T00:00:00Z`,
      })),
    },
  }
}

/** Returns a fetch mock that serves payments and memo endpoints. */
function makeFetchMock(wallet: string, txHashes: string[]) {
  return (url: RequestInfo | URL): Promise<Response> => {
    const urlStr = url.toString()
    if (urlStr.includes('/payments')) {
      return Promise.resolve(
        new Response(JSON.stringify(makePaymentsResponse(wallet, txHashes)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }
    // memo fetch
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
  }
}

describe('useTransactionHistory', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches transactions for the initial wallet key', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeFetchMock(WALLET_A, ['hash1', 'hash2']))

    const { result } = renderHook(() => useTransactionHistory(WALLET_A))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.transactions).toHaveLength(2)
    expect(result.current.error).toBeNull()
  })

  it('returns empty transactions and no error when publicKey is null', async () => {
    const { result } = renderHook(() => useTransactionHistory(null))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.transactions).toEqual([])
    expect(result.current.error).toBeNull()
  })

  // AC3 — previous wallet data cleared immediately on switch
  it('clears stale transactions and sets loading=true immediately when wallet changes (AC3)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeFetchMock(WALLET_A, ['hash-a1']))

    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) => useTransactionHistory(key),
      { initialProps: { key: WALLET_A } }
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.transactions).toHaveLength(1)

    // Block the next fetch so we can inspect the cleared state.
    let resolveNewFetch!: (r: Response) => void
    fetchSpy.mockImplementation((url: RequestInfo | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('/payments')) {
        return new Promise<Response>((res) => {
          resolveNewFetch = res
        })
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
    })

    act(() => {
      rerender({ key: WALLET_B })
    })

    // Previous wallet data must be cleared before the new fetch resolves.
    expect(result.current.transactions).toEqual([])
    expect(result.current.loading).toBe(true)

    // Unblock the fetch and verify the new data loads.
    await act(async () => {
      resolveNewFetch(
        new Response(JSON.stringify(makePaymentsResponse(WALLET_B, ['b1', 'b2', 'b3'])), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.transactions).toHaveLength(3)
  })

  // AC1 — wallet switch triggers immediate refetch
  it('refetches immediately on wallet switch without waiting for REFRESH_INTERVAL (AC1)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeFetchMock(WALLET_A, ['hash-a1']))

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useTransactionHistory(key),
      { initialProps: { key: WALLET_A } }
    )

    await waitFor(() => expect(result.current.loading).toBe(false))

    const callsAfterFirstLoad = fetchSpy.mock.calls.length

    // Switch wallet — DO NOT advance timers; fetch must fire immediately.
    fetchSpy.mockImplementation(makeFetchMock(WALLET_B, ['hash-b1']))

    act(() => {
      rerender({ key: WALLET_B })
    })

    await waitFor(() => expect(result.current.loading).toBe(false))

    const newCalls = fetchSpy.mock.calls.slice(callsAfterFirstLoad)
    expect(newCalls.length).toBeGreaterThanOrEqual(1)

    // The first new payments fetch must target WALLET_B.
    const paymentCall = newCalls.find((c) => (c[0] as string).includes('/payments'))
    expect(paymentCall).toBeDefined()
    expect(paymentCall![0] as string).toContain(WALLET_B)
  })

  // AC1 / AC2 — new address is requested, not the stale one
  it('requests the new wallet address after a switch, not the previous one (AC1/AC2)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (url: RequestInfo | URL): Promise<Response> => {
        const urlStr = url.toString()
        if (urlStr.includes(WALLET_A) && urlStr.includes('/payments')) {
          return Promise.resolve(
            new Response(JSON.stringify(makePaymentsResponse(WALLET_A, ['a1'])), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          )
        }
        if (urlStr.includes(WALLET_B) && urlStr.includes('/payments')) {
          return Promise.resolve(
            new Response(JSON.stringify(makePaymentsResponse(WALLET_B, ['b1', 'b2'])), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          )
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
      }
    )

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useTransactionHistory(key),
      { initialProps: { key: WALLET_A } }
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.transactions).toHaveLength(1)

    act(() => rerender({ key: WALLET_B }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.transactions).toHaveLength(2)

    const urls = fetchSpy.mock.calls.map((c) => c[0] as string)
    expect(urls.some((u) => u.includes(WALLET_B) && u.includes('/payments'))).toBe(true)
  })

  it('handles 404 by returning empty transactions and no error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 })
    )

    const { result } = renderHook(() => useTransactionHistory(WALLET_A))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.transactions).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('sets error on non-404 Horizon failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('error', { status: 500 })
    )

    const { result } = renderHook(() => useTransactionHistory(WALLET_A))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toMatch(/Horizon error: 500/)
  })

  it('exposes a refresh function that triggers a new fetch', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeFetchMock(WALLET_A, ['hash1']))

    const { result } = renderHook(() => useTransactionHistory(WALLET_A))

    await waitFor(() => expect(result.current.loading).toBe(false))
    const callsBefore = fetchSpy.mock.calls.length

    act(() => {
      result.current.refresh()
    })

    await waitFor(() => {
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore)
    })
  })

  it('polls at REFRESH_INTERVAL after initial fetch', async () => {
    // Use fake timers but allow Date/setTimeout to advance automatically so
    // waitFor (which relies on real setTimeout internally) still functions.
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeFetchMock(WALLET_A, []))

    const { result } = renderHook(() => useTransactionHistory(WALLET_A))

    await waitFor(() => expect(result.current.loading).toBe(false))

    const callsBefore = fetchSpy.mock.calls.length

    // Advance by one full poll interval to trigger the setInterval callback
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })

    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore))

    vi.useRealTimers()
  })
})
