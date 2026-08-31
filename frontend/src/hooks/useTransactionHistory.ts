import { useState, useEffect, useRef, useCallback } from 'react'

const HORIZON_URL = 'https://horizon-testnet.stellar.org'

export interface TransactionEvent {
  amount: string
  direction: 'in' | 'out'
  counterparty: string
  memo?: string
  timestamp: string
  txHash: string
}

const REFRESH_INTERVAL = 30_000
const DAY_MS = 24 * 60 * 60 * 1000

interface TransactionHistoryResult {
  transactions: TransactionEvent[]
  loading: boolean
  error: string | null
  refresh: () => void
}

export interface TransactionFilters {
  /** Case-insensitive substring match against tx hash, counterparty, and memo. */
  search: string
  /** Inclusive lower bound, as a `YYYY-MM-DD` date-input value, or null for no bound. */
  from: string | null
  /** Inclusive upper bound (end of day), as a `YYYY-MM-DD` date-input value, or null for no bound. */
  to: string | null
}

export interface DailySpendPoint {
  /** `YYYY-MM-DD`, in UTC (matches the Horizon `created_at` timestamps we bucket). */
  date: string
  total: number
}

export interface AgentSpendSlice {
  /**
   * The payment counterparty address. There is currently no backend mapping from a
   * Stellar wallet address to an agent's registry id/name/capability, so this is
   * the closest available proxy for "agent" - consistent with how `PaymentTimeline`
   * already treats a payment's counterparty as the paying/paid agent.
   */
  counterparty: string
  total: number
}

/**
 * Filters transactions by free-text search (tx hash / counterparty / memo) and an
 * inclusive date range. Pure and side-effect free so it can be unit tested and
 * reused by both the table and the charts without re-deriving filter logic.
 */
export function filterTransactions(
  transactions: TransactionEvent[],
  filters: TransactionFilters
): TransactionEvent[] {
  const search = filters.search.trim().toLowerCase()
  const fromTime = filters.from ? new Date(filters.from).getTime() : null
  // `to` is a date-only input; treat it as inclusive through the end of that day.
  const toTime = filters.to ? new Date(filters.to).getTime() + DAY_MS - 1 : null

  return transactions.filter((tx) => {
    if (search) {
      const haystack = `${tx.txHash} ${tx.counterparty} ${tx.memo ?? ''}`.toLowerCase()
      if (!haystack.includes(search)) return false
    }

    const txTime = new Date(tx.timestamp).getTime()
    if (Number.isNaN(txTime)) return true
    if (fromTime !== null && txTime < fromTime) return false
    if (toTime !== null && txTime > toTime) return false
    return true
  })
}

/**
 * Buckets outgoing (`out`) payments into one total per calendar day (UTC) over the
 * trailing `days` window, including days with zero spend so the bar chart has a
 * continuous x-axis.
 */
export function aggregateDailySpend(transactions: TransactionEvent[], days = 30): DailySpendPoint[] {
  const now = Date.now()
  const buckets = new Map<string, number>()
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(now - i * DAY_MS).toISOString().slice(0, 10)
    buckets.set(key, 0)
  }

  const cutoff = now - days * DAY_MS
  for (const tx of transactions) {
    if (tx.direction !== 'out') continue
    const txTime = new Date(tx.timestamp).getTime()
    if (Number.isNaN(txTime) || txTime < cutoff) continue

    const key = tx.timestamp.slice(0, 10)
    if (!buckets.has(key)) continue
    const amount = parseFloat(tx.amount)
    if (Number.isNaN(amount)) continue
    buckets.set(key, (buckets.get(key) ?? 0) + amount)
  }

  return Array.from(buckets.entries()).map(([date, total]) => ({
    date,
    total: Number(total.toFixed(7)),
  }))
}

/**
 * Sums outgoing (`out`) payments per counterparty, sorted descending, collapsing
 * everything past `limit - 1` into an `other` slice so the pie chart stays legible
 * for wallets with many distinct counterparties.
 */
export function aggregateByCounterparty(transactions: TransactionEvent[], limit = 8): AgentSpendSlice[] {
  const totals = new Map<string, number>()
  for (const tx of transactions) {
    if (tx.direction !== 'out') continue
    const amount = parseFloat(tx.amount)
    if (Number.isNaN(amount)) continue
    totals.set(tx.counterparty, (totals.get(tx.counterparty) ?? 0) + amount)
  }

  const sorted = Array.from(totals.entries())
    .map(([counterparty, total]) => ({ counterparty, total: Number(total.toFixed(7)) }))
    .sort((a, b) => b.total - a.total)

  if (sorted.length <= limit) return sorted

  const top = sorted.slice(0, limit - 1)
  const otherTotal = sorted.slice(limit - 1).reduce((sum, slice) => sum + slice.total, 0)
  return [...top, { counterparty: 'other', total: Number(otherTotal.toFixed(7)) }]
}

/**
 * Net XLM total (incoming minus outgoing) across the given transactions. Callers
 * pass the currently filtered/visible set so the total on screen always matches
 * what's on screen.
 */
export function computeRunningTotal(transactions: TransactionEvent[]): number {
  const total = transactions.reduce((sum, tx) => {
    const amount = parseFloat(tx.amount)
    if (Number.isNaN(amount)) return sum
    return sum + (tx.direction === 'in' ? amount : -amount)
  }, 0)
  return Number(total.toFixed(7))
}

async function fetchMemo(txHash: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${HORIZON_URL}/transactions/${txHash}`)
    if (!res.ok) return undefined
    const data = await res.json()
    return data.memo || undefined
  } catch {
    return undefined
  }
}

export function useTransactionHistory(publicKey: string | null): TransactionHistoryResult {
  const [transactions, setTransactions] = useState<TransactionEvent[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const keyRef = useRef<string | null>(publicKey)
  const fetchingRef = useRef(false)
  const isFirstLoad = useRef(true)

  keyRef.current = publicKey

  const fetchHistory = useCallback(async () => {
    const key = keyRef.current
    if (!key) {
      setTransactions([])
      setError(null)
      return
    }

    if (fetchingRef.current) return
    fetchingRef.current = true
    if (isFirstLoad.current) {
      setLoading(true)
    }

    try {
      // Fetch last 20 payment operations
      const res = await fetch(
        `${HORIZON_URL}/accounts/${key}/payments?limit=20&order=desc`
      )
      if (!res.ok) {
        if (res.status === 404) {
          setTransactions([])
          setError(null)
          return
        }
        throw new Error(`Horizon error: ${res.status}`)
      }

      const data = await res.json()
      const records: Array<{
        amount: string
        from: string
        to: string
        transaction_hash: string
        created_at: string
        type: string
      }> = data._embedded?.records ?? []

      // Filter only payment operations
      const paymentRecords = records.filter((r) => r.type === 'payment')

      // Fetch memos in parallel
      const memoResults = await Promise.allSettled(
        paymentRecords.map((r) => fetchMemo(r.transaction_hash))
      )

      const parsed: TransactionEvent[] = paymentRecords.map((r, i) => {
        const isIncoming = r.to === key
        const memoResult = memoResults[i]
        const memo =
          memoResult?.status === 'fulfilled' ? memoResult.value : undefined

        return {
          amount: r.amount,
          direction: isIncoming ? 'in' : 'out',
          counterparty: isIncoming ? r.from : r.to,
          memo,
          timestamp: r.created_at,
          txHash: r.transaction_hash,
        }
      })

      setTransactions(parsed)
      setError(null)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to fetch transactions'
      setError(message)
    } finally {
      setLoading(false)
      fetchingRef.current = false
    }
  }, [])

  useEffect(() => {
    fetchHistory()

    const interval = setInterval(fetchHistory, REFRESH_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchHistory])

  const refresh = useCallback(() => {
    fetchHistory()
  }, [fetchHistory])

  return { transactions, loading, error, refresh }
}
