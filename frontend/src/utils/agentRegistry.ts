import type { AgentRecord } from '../types/api'
import { fuzzyMatch } from './fuzzy'

export type SortKey = 'price' | 'reputation'
export type SortDir = 'asc' | 'desc'
export type StatusFilter = 'all' | 'active' | 'inactive'
export type SortByOption = 'relevance' | 'price_asc' | 'price_desc' | 'reputation'

export interface AgentFilters {
  query?: string
  /** Selected capabilities. An agent matches if it has at least one of these (OR). */
  capabilities: string[]
  /** Inclusive lower bound on price, or null for no lower bound. */
  priceMin: number | null
  /** Inclusive upper bound on price, or null for no upper bound. */
  priceMax: number | null
  status: StatusFilter
  sortKey: SortKey | null
  sortDir: SortDir
  sortBy?: SortByOption
}

export const DEFAULT_FILTERS: AgentFilters = {
  query: '',
  capabilities: [],
  priceMin: null,
  priceMax: null,
  status: 'all',
  sortKey: null,
  sortDir: 'desc',
  sortBy: 'relevance',
}

/**
 * Normalize a raw record from `GET /api/agents` into the canonical shape used by
 * the UI. The backend has historically exposed two shapes (`capability`/`priceXLM`
 * vs `capabilities[]`/`price`), so we tolerate both rather than assuming one.
 */
export function normalizeAgent(raw: unknown): AgentRecord {
  const r = (raw ?? {}) as Record<string, unknown>

  const capabilities = Array.isArray(r.capabilities)
    ? (r.capabilities as unknown[]).map(String)
    : typeof r.capability === 'string' && r.capability
      ? [r.capability]
      : []

  const price =
    typeof r.price === 'number'
      ? r.price
      : typeof r.priceXLM === 'number'
        ? r.priceXLM
        : 0

  const reputation = typeof r.reputation === 'number' ? r.reputation : 0
  const id = String(r.id ?? '')
  const rawStatus = typeof r.status === 'string' ? r.status : 'unknown'
  const status = rawStatus === 'online' ? 'active' : rawStatus === 'offline' ? 'inactive' : rawStatus

  return {
    id,
    name: typeof r.name === 'string' && r.name ? r.name : id || 'Unknown',
    capabilities,
    price,
    reputation,
    status,
    endpoint: typeof r.endpoint === 'string' ? r.endpoint : undefined,
    registrationTxHash:
      (typeof r.registrationTxHash === 'string' && r.registrationTxHash) ||
      (typeof r.txHash === 'string' && r.txHash) ||
      undefined,
  }

}

/** Distinct capabilities present across the dataset, sorted alphabetically. */
export function allCapabilities(agents: AgentRecord[]): string[] {
  const set = new Set<string>()
  agents.forEach((a) => a.capabilities.forEach((c) => set.add(c)))
  return Array.from(set).sort()
}

/** [min, max] price across the dataset; [0, 0] when empty. */
export function priceDomain(agents: AgentRecord[]): [number, number] {
  if (agents.length === 0) return [0, 0]
  let min = Infinity
  let max = -Infinity
  for (const a of agents) {
    if (a.price < min) min = a.price
    if (a.price > max) max = a.price
  }
  return [min, max]
}

/** Apply filters then sort. Pure — never mutates the input array. */
export function filterAndSortAgents(
  agents: AgentRecord[],
  filters: AgentFilters
): AgentRecord[] {
  const query = filters.query?.trim() ?? ''
  const matchScores = new Map<string, number>()

  const filtered = agents.filter((agent) => {
    // 1. Capability filter (OR logic)
    if (filters.capabilities.length > 0) {
      const matches = filters.capabilities.some((c) => agent.capabilities.includes(c))
      if (!matches) return false
    }

    if (filters.priceMin != null && agent.price < filters.priceMin) return false
    if (filters.priceMax != null && agent.price > filters.priceMax) return false
    if (filters.status !== 'all' && agent.status !== filters.status) return false

    // 2. Fuzzy search filter
    if (query.length > 0) {
      const nameMatch = fuzzyMatch(query, agent.name)
      const idMatch = fuzzyMatch(query, agent.id)
      const capMatches = agent.capabilities.map((c) => fuzzyMatch(query, c)).filter(Boolean)
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
    }

    return true
  })

  // 3. Sorting
  if (filters.sortBy) {
    if (filters.sortBy === 'relevance' && query.length > 0) {
      return [...filtered].sort((a, b) => {
        const scoreA = matchScores.get(a.id) ?? 0
        const scoreB = matchScores.get(b.id) ?? 0
        return scoreB - scoreA
      })
    }
    if (filters.sortBy === 'price_asc') {
      return [...filtered].sort((a, b) => a.price - b.price)
    }
    if (filters.sortBy === 'price_desc') {
      return [...filtered].sort((a, b) => b.price - a.price)
    }
    if (filters.sortBy === 'reputation') {
      return [...filtered].sort((a, b) => b.reputation - a.reputation)
    }
  }

  if (!filters.sortKey) return filtered

  const key = filters.sortKey
  const factor = filters.sortDir === 'asc' ? 1 : -1
  return [...filtered].sort((a, b) => (a[key] - b[key]) * factor)
}

// --- URL query-string (de)serialization -----------------------------------
// Filter/sort state lives in the URL so views are shareable. We only emit
// params that differ from the defaults to keep links tidy.

export function filtersToSearchParams(filters: AgentFilters): Record<string, string> {
  const params: Record<string, string> = {}

  if (filters.query) {
    params.q = filters.query
  }
  if (filters.capabilities.length > 0) {
    params.caps = filters.capabilities.join(',')
  }
  if (filters.priceMin != null) params.pmin = String(filters.priceMin)
  if (filters.priceMax != null) params.pmax = String(filters.priceMax)
  if (filters.status !== 'all') params.status = filters.status
  if (filters.sortBy && filters.sortBy !== 'relevance') {
    params.sortBy = filters.sortBy
  }
  if (filters.sortKey) {
    params.sort = filters.sortKey
    params.dir = filters.sortDir
  }

  return params
}

function parseNumber(value: string | null): number | null {
  if (value == null || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function filtersFromSearchParams(params: URLSearchParams): AgentFilters {
  const caps = params.get('caps')
  const status = params.get('status')
  const sort = params.get('sort')
  const dir = params.get('dir')
  const q = params.get('q') || params.get('query') || ''
  const sortBy = params.get('sortBy') as SortByOption | null

  return {
    query: q,
    capabilities: caps ? caps.split(',').map((c) => c.trim()).filter(Boolean) : [],
    priceMin: parseNumber(params.get('pmin')),
    priceMax: parseNumber(params.get('pmax')),
    status: status === 'active' || status === 'inactive' ? status : 'all',
    sortKey: sort === 'price' || sort === 'reputation' ? sort : null,
    sortDir: dir === 'asc' ? 'asc' : 'desc',
    sortBy: sortBy || 'relevance',
  }
}
