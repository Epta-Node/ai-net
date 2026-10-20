import { useState, useEffect, useRef, useCallback } from 'react'

const HORIZON_URL = 'https://horizon-testnet.stellar.org'
const DEFAULT_POLL_INTERVAL = 5_000
const BASE_RESERVE_XLM = 0.5

export interface WalletBalance {
  asset_type: 'native' | 'credit_alphanum4' | 'credit_alphanum12'
  asset_code?: string
  asset_issuer?: string
  balance: string
}

export interface UseWalletBalanceOptions {
  publicKey?: string | null
  pollIntervalMs?: number // default: 5000
  pauseWhenHidden?: boolean // default: true (Page Visibility API)
  pauseWhenNoActiveTask?: boolean // default: true
}

export interface UseWalletBalanceResult {
  balanceXLM: string | null
  reservedXLM: string | null // minimum balance locked by Stellar
  availableXLM: string | null // balanceXLM - reservedXLM
  lastUpdatedAt: Date | null
  isLoading: boolean
  error: Error | null
  refresh: () => void // manual refresh trigger
  // Backwards compatibility fields
  balance: string
  balances: WalletBalance[]
  loading: boolean
}

/**
 * Tracks active tasks count globally so balance polling can pause when idle.
 */
let globalActiveTaskCount = 0

export function notifyTaskStarted(): void {
  globalActiveTaskCount++
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('ai-net:task-started'))
  }
}

export function notifyTaskCompleted(): void {
  globalActiveTaskCount = Math.max(0, globalActiveTaskCount - 1)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('ai-net:task-completed'))
  }
}

export function getActiveTaskCount(): number {
  return globalActiveTaskCount
}

/**
 * Live Stellar XLM balance hook with smart polling, visibility-aware pause,
 * and background refresh triggers (#822).
 */
export function useWalletBalance(
  optionsOrKey: string | null | UseWalletBalanceOptions
): UseWalletBalanceResult {
  const isLegacy = typeof optionsOrKey === 'string' || optionsOrKey === null
  const options: UseWalletBalanceOptions = isLegacy
    ? { publicKey: optionsOrKey, pauseWhenNoActiveTask: false }
    : { pauseWhenNoActiveTask: true, ...optionsOrKey }

  const {
    publicKey = null,
    pollIntervalMs = DEFAULT_POLL_INTERVAL,
    pauseWhenHidden = true,
    pauseWhenNoActiveTask = true,
  } = options

  const [balanceXLM, setBalanceXLM] = useState<string | null>(null)
  const [reservedXLM, setReservedXLM] = useState<string | null>(null)
  const [availableXLM, setAvailableXLM] = useState<string | null>(null)
  const [balances, setBalances] = useState<WalletBalance[]>([])
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<Error | null>(null)

  const isFirstLoad = useRef(true)
  const activeTaskCountRef = useRef(globalActiveTaskCount)

  // Clear state on key switch
  useEffect(() => {
    setBalanceXLM('0')
    setReservedXLM('0')
    setAvailableXLM('0')
    setBalances([])
    setError(null)
    setIsLoading(true)
    isFirstLoad.current = true
  }, [publicKey])

  const fetchBalance = useCallback(async () => {
    if (!publicKey) {
      setBalanceXLM('0')
      setReservedXLM('0')
      setAvailableXLM('0')
      setBalances([])
      setError(null)
      setIsLoading(false)
      return
    }

    if (isFirstLoad.current) {
      setIsLoading(true)
    }

    try {
      const res = await fetch(`${HORIZON_URL}/accounts/${publicKey}`)
      if (!res.ok) {
        if (res.status === 404) {
          setBalanceXLM('0')
          setReservedXLM('0')
          setAvailableXLM('0')
          setBalances([])
          setError(null)
          setLastUpdatedAt(new Date())
          return
        }
        throw new Error(`Horizon error: ${res.status}`)
      }

      const data = await res.json()
      const rawBalances: WalletBalance[] = Array.isArray(data.balances) ? data.balances : []
      const nativeBalanceEntry = rawBalances.find((b) => b.asset_type === 'native')
      const nativeAmount = nativeBalanceEntry?.balance ?? '0'

      // Stellar reserve: (2 + subentries) * base_reserve
      const subentries = typeof data.subentry_count === 'number' ? data.subentry_count : 0
      const calculatedReserved = ((2 + subentries) * BASE_RESERVE_XLM).toFixed(7)
      const parsedNative = parseFloat(nativeAmount) || 0
      const parsedReserved = parseFloat(calculatedReserved) || 0
      const calculatedAvailable = Math.max(0, parsedNative - parsedReserved).toFixed(7)

      setBalanceXLM(nativeAmount)
      setReservedXLM(calculatedReserved)
      setAvailableXLM(calculatedAvailable)
      setBalances(rawBalances)
      setError(null)
      setLastUpdatedAt(new Date())
      isFirstLoad.current = false
    } catch (err) {
      const errObj = err instanceof Error ? err : new Error('Failed to fetch balance')
      setError(errObj)
    } finally {
      setIsLoading(false)
    }
  }, [publicKey])

  // Polling setup with visibility and active task gating
  useEffect(() => {
    if (!publicKey) return

    void fetchBalance()

    const intervalId = setInterval(() => {
      // Pause if tab is hidden
      if (pauseWhenHidden && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }

      // Pause if no tasks running (unless configured not to pause)
      if (pauseWhenNoActiveTask && activeTaskCountRef.current === 0 && globalActiveTaskCount === 0) {
        return
      }

      void fetchBalance()
    }, pollIntervalMs)

    // Resume immediately when tab becomes visible
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void fetchBalance()
      }
    }

    // Resume immediately when task starts
    const handleTaskStarted = () => {
      activeTaskCountRef.current = globalActiveTaskCount
      void fetchBalance()
    }

    const handleTaskCompleted = () => {
      activeTaskCountRef.current = globalActiveTaskCount
      void fetchBalance()
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('ai-net:task-started', handleTaskStarted)
      window.addEventListener('ai-net:task-completed', handleTaskCompleted)
    }

    return () => {
      clearInterval(intervalId)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('ai-net:task-started', handleTaskStarted)
        window.removeEventListener('ai-net:task-completed', handleTaskCompleted)
      }
    }
  }, [publicKey, fetchBalance, pollIntervalMs, pauseWhenHidden, pauseWhenNoActiveTask])

  const refresh = useCallback(() => {
    void fetchBalance()
  }, [fetchBalance])

  return {
    balanceXLM,
    reservedXLM,
    availableXLM,
    lastUpdatedAt,
    isLoading,
    error,
    refresh,
    balance: balanceXLM ?? '0',
    balances,
    loading: isLoading,
  }
}

export default useWalletBalance
