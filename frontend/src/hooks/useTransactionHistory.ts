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

interface TransactionHistoryResult {
  transactions: TransactionEvent[]
  loading: boolean
  error: string | null
  refresh: () => void
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
        const memo =
          memoResults[i]?.status === 'fulfilled' ? memoResults[i].value : undefined

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
