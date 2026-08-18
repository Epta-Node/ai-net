import { useState, useEffect, useRef, useCallback } from 'react'

const HORIZON_URL = 'https://horizon-testnet.stellar.org'
const POLL_INTERVAL = 10_000

interface BalanceInfo {
  balance: string
  loading: boolean
  error: string | null
}

export function useWalletBalance(publicKey: string | null): BalanceInfo {
  const [balance, setBalance] = useState<string>('0')
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
          setError(null)
          return
        }
        throw new Error(`Horizon error: ${res.status}`)
      }
      const data = await res.json()
      const xlmBalance = data.balances?.find(
        (b: { asset_type: string }) => b.asset_type === 'native'
      )
      setBalance(xlmBalance?.balance ?? '0')
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

  return { balance, loading, error }
}
