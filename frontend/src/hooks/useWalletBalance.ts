import { useState, useEffect, useRef, useCallback } from 'react'

const HORIZON_URL = 'https://horizon-testnet.stellar.org'
const POLL_INTERVAL = 10_000

export interface WalletBalance {
  asset_type: 'native' | 'credit_alphanum4' | 'credit_alphanum12'
  asset_code?: string
  asset_issuer?: string
  balance: string
}

interface BalanceInfo {
  /** Native XLM balance (kept for backward compatibility). */
  balance: string
  /** Full set of on-chain balances including native XLM and issued tokens. */
  balances: WalletBalance[]
  loading: boolean
  error: string | null
}

/**
 * Fetches the full balance set for a Stellar account from Horizon. The native
 * XLM balance is always present for a funded account; additional trustlines
 * surface as `credit_alphanum4`/`credit_alphanum12` issued-asset entries.
 */
export function useWalletBalance(publicKey: string | null): BalanceInfo {
  const [balance, setBalance] = useState<string>('0')
  const [balances, setBalances] = useState<WalletBalance[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const isFirstLoad = useRef(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const keyRef = useRef<string | null>(publicKey)

  keyRef.current = publicKey

  const fetchBalance = useCallback(async () => {
    const key = keyRef.current
    if (!key) {
      setBalance('0')
      setBalances([])
      setError(null)
      return
    }

    // Only show loading indicator on the first fetch, not on subsequent polls
    if (isFirstLoad.current) {
      setLoading(true)
    }
    try {
      const res = await fetch(`${HORIZON_URL}/accounts/${key}`)
      if (!res.ok) {
        if (res.status === 404) {
          setBalance('0')
          setBalances([])
          setError(null)
          return
        }
        throw new Error(`Horizon error: ${res.status}`)
      }
      const data = await res.json()
      const rawBalances: WalletBalance[] = Array.isArray(data.balances) ? data.balances : []
      const xlmBalance = rawBalances.find((b) => b.asset_type === 'native')
      setBalance(xlmBalance?.balance ?? '0')
      setBalances(rawBalances)
      setError(null)
      isFirstLoad.current = false
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch balance'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBalance()

    intervalRef.current = setInterval(fetchBalance, POLL_INTERVAL)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [fetchBalance])

  return { balance, balances, loading, error }
}
