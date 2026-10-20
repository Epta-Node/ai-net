import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAgentsPage } from '../services/api'
import type { AgentRecord } from '../types/api'
import { normalizeAgent } from '../utils/agentRegistry'
import { fuzzyMatch } from '../utils/fuzzy'

const REFRESH_INTERVAL = 30_000

export type AgentSortOption = 'relevance' | 'price_asc' | 'price_desc' | 'reputation'

export interface AgentRegistryOptions {
  refreshInterval?: number
  query?: string
  capabilities?: string[]
  sortBy?: AgentSortOption
}

export type UseAgentRegistryOptions = AgentRegistryOptions

export interface AgentRegistryResult {
  agents: AgentRecord[]
  isLoading: boolean
  capabilities: string[]
  loading: boolean
  error: string | null
  refetch: () => void
  nextPage: () => void
  firstPage: () => void
  hasNextPage: boolean
  isFirstPage: boolean
  fetching: boolean
}

export type UseAgentRegistryResult = AgentRegistryResult

/**
 * Fetches the agent registry from `GET /api/agents` and keeps it fresh with a
 * background poll and window focus listener. Supports in-memory fuzzy search,
 * capability-tag filtering, and instant sort order updates (#823).
 */
export function useAgentRegistry(options: UseAgentRegistryOptions = {}): AgentRegistryResult {
  const {
    refreshInterval = REFRESH_INTERVAL,
    query = '',
    capabilities: selectedCapabilities = [],
    sortBy = 'relevance',
  } = options

  const [rawAgents, setRawAgents] = useState<AgentRecord[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [isFirstPage, setIsFirstPage] = useState(true)
  const [fetching, setFetching] = useState(false)
  const currentCursor = useRef<string | undefined>(undefined)
  const isFirstLoad = useRef(true)
  const fetchingRef = useRef(false)
  const mountedRef = useRef(true)

  const fetchAgents = useCallback(async (requestedCursor: string | null | undefined = currentCursor.current) => {
    const cursor = requestedCursor ?? undefined
    if (fetchingRef.current) return
    fetchingRef.current = true
    setFetching(true)

    if (isFirstLoad.current) setLoading(true)

    try {
      const data = await getAgentsPage(cursor)
      if (!mountedRef.current) return
      currentCursor.current = cursor
      setIsFirstPage(cursor === undefined)
      setNextCursor(data.pagination.nextCursor)
      setRawAgents(data.items.map(normalizeAgent))
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load agents')
    } finally {
      if (mountedRef.current) {
        setLoading(false)
        setFetching(false)
      }
      isFirstLoad.current = false
      fetchingRef.current = false
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    fetchAgents()

    const interval = setInterval(fetchAgents, refreshInterval)
    const handleFocus = () => fetchAgents()
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleFocus)
    }

    return () => {
      mountedRef.current = false
      clearInterval(interval)
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleFocus)
      }
    }
  }, [fetchAgents, refreshInterval])

  const refetch = useCallback(() => {
    fetchAgents()
  }, [fetchAgents])

  // All unique capabilities across raw agents for filter pills
  const allCapabilities = useMemo(() => {
    const set = new Set<string>()
    for (const a of rawAgents) {
      for (const cap of a.capabilities) {
        if (cap) set.add(cap)
      }
    }
    return Array.from(set).sort()
  }, [rawAgents])

  // In-memory filtered and sorted agents
  const processedAgents = useMemo(() => {
    let result = [...rawAgents]

    // 1. Filter by capability tags (OR logic between tags)
    if (selectedCapabilities.length > 0) {
      result = result.filter((agent) =>
        agent.capabilities.some((c) => selectedCapabilities.includes(c))
      )
    }

    // 2. Fuzzy search filter
    const trimmedQuery = query.trim()
    const matchScores = new Map<string, number>()

    if (trimmedQuery.length > 0) {
      result = result.filter((agent) => {
        const nameMatch = fuzzyMatch(trimmedQuery, agent.name)
        const idMatch = fuzzyMatch(trimmedQuery, agent.id)
        const capMatches = agent.capabilities.map((c) => fuzzyMatch(trimmedQuery, c)).filter(Boolean)
        const bestCapScore = capMatches.length > 0 ? Math.max(...capMatches.map((m) => m!.score)) : -Infinity

        const bestScore = Math.max(
          nameMatch ? nameMatch.score : -Infinity,
          idMatch ? idMatch.score : -Infinity,
          bestCapScore
        )

        if (bestScore > -Infinity) {
          matchScores.set(agent.id, bestScore)
          return true
        }
        return false
      })
    }

    // 3. Instant sorting without API refetch
    result.sort((a, b) => {
      if (sortBy === 'relevance' && trimmedQuery.length > 0) {
        const scoreA = matchScores.get(a.id) ?? 0
        const scoreB = matchScores.get(b.id) ?? 0
        if (scoreB !== scoreA) return scoreB - scoreA
      }
      if (sortBy === 'price_asc') {
        return a.price - b.price
      }
      if (sortBy === 'price_desc') {
        return b.price - a.price
      }
      if (sortBy === 'reputation') {
        return b.reputation - a.reputation
      }
      // Default: reputation then name
      if (b.reputation !== a.reputation) return b.reputation - a.reputation
      return a.name.localeCompare(b.name)
    })

    return result
  }, [rawAgents, query, selectedCapabilities, sortBy])

  return {
    agents: processedAgents,
    isLoading: loading,
    loading,
    capabilities: allCapabilities,
    error,
    refetch,
    fetching,
    isFirstPage,
    hasNextPage: nextCursor !== null,
    nextPage: () => { if (nextCursor) void fetchAgents(nextCursor) },
    firstPage: () => { void fetchAgents(null) },
  }
}

export default useAgentRegistry
