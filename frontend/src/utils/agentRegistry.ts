import type { AgentRecord } from '../types/api'

export type SortKey = 'price' | 'reputation'
export type SortDir = 'asc' | 'desc'
export type StatusFilter = 'all' | 'active' | 'inactive'

export interface AgentFilters {
  /** Selected capabilities. An agent matches if it has at least one of these (OR). */
  capabilities: string[]
  /** Inclusive lower bound on price, or null for no lower bound. */
  priceMin: number | null
  /** Inclusive upper bound on price, or null for no upper bound. */
  priceMax: number | null
  status: StatusFilter
  sortKey: SortKey | null
  sortDir: SortDir
}

export const DEFAULT_FILTERS: AgentFilters = {
  capabilities: [],
  priceMin: null,
  priceMax: null,
  status: 'all',
  sortKey: null,
  sortDir: 'desc',
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
  const filtered = agents.filter((agent) => {
    if (filters.capabilities.length > 0) {
      const matches = filters.capabilities.some((c) => agent.capabilities.includes(c))
      if (!matches) return false
    }

    if (filters.priceMin != null && agent.price < filters.priceMin) return false
    if (filters.priceMax != null && agent.price > filters.priceMax) return false

    if (filters.status !== 'all' && agent.status !== filters.status) return false

    return true
  })

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

  if (filters.capabilities.length > 0) {
    params.caps = filters.capabilities.join(',')
  }
  if (filters.priceMin != null) params.pmin = String(filters.priceMin)
  if (filters.priceMax != null) params.pmax = String(filters.priceMax)
  if (filters.status !== 'all') params.status = filters.status
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

  return {
    capabilities: caps ? caps.split(',').map((c) => c.trim()).filter(Boolean) : [],
    priceMin: parseNumber(params.get('pmin')),
    priceMax: parseNumber(params.get('pmax')),
    status: status === 'active' || status === 'inactive' ? status : 'all',
    sortKey: sort === 'price' || sort === 'reputation' ? sort : null,
    sortDir: dir === 'asc' ? 'asc' : 'desc',
  }
}
