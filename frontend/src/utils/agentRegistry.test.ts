import { describe, it, expect } from 'vitest'
import {
  allCapabilities,
  filterAndSortAgents,
  filtersFromSearchParams,
  filtersToSearchParams,
  normalizeAgent,
  priceDomain,
  DEFAULT_FILTERS,
  type AgentFilters,
} from '@utils/agentRegistry'
import type { AgentRecord } from '../types/api'

const agents: AgentRecord[] = [
  {
    id: 'a1',
    name: 'Alpha',
    capabilities: ['research', 'report'],
    price: 0.5,
    reputation: 4.8,
    status: 'active',
  },
  {
    id: 'a2',
    name: 'Beta',
    capabilities: ['coding'],
    price: 1.2,
    reputation: 4.9,
    status: 'active',
  },
  {
    id: 'a3',
    name: 'Gamma',
    capabilities: ['coding', 'audit'],
    price: 0.8,
    reputation: 4.2,
    status: 'inactive',
  },
]

describe('normalizeAgent', () => {
  it('passes through the canonical frontend shape', () => {
    const result = normalizeAgent(agents[0])
    expect(result).toMatchObject({ id: 'a1', capabilities: ['research', 'report'], price: 0.5 })
  })

  it('normalizes the backend shape (capability/priceXLM)', () => {
    const result = normalizeAgent({
      id: 'b1',
      capability: 'research',
      priceXLM: 2.5,
      endpoint: 'https://x.test',
      status: 'registered',
    })
    expect(result.capabilities).toEqual(['research'])
    expect(result.price).toBe(2.5)
    expect(result.name).toBe('b1')
  })

  it('falls back to safe defaults for missing fields', () => {
    const result = normalizeAgent({ id: 'c1' })
    expect(result.capabilities).toEqual([])
    expect(result.price).toBe(0)
    expect(result.reputation).toBe(0)
    expect(result.status).toBe('unknown')
  })
})

describe('allCapabilities', () => {
  it('returns sorted distinct capabilities', () => {
    expect(allCapabilities(agents)).toEqual(['audit', 'coding', 'report', 'research'])
  })
})

describe('priceDomain', () => {
  it('returns min and max price', () => {
    expect(priceDomain(agents)).toEqual([0.5, 1.2])
  })

  it('returns [0,0] when empty', () => {
    expect(priceDomain([])).toEqual([0, 0])
  })
})

describe('filterAndSortAgents', () => {
  it('returns all agents with default filters', () => {
    expect(filterAndSortAgents(agents, DEFAULT_FILTERS)).toHaveLength(3)
  })

  it('filters by capability (OR semantics)', () => {
    const result = filterAndSortAgents(agents, { ...DEFAULT_FILTERS, capabilities: ['research'] })
    expect(result.map((a) => a.id)).toEqual(['a1'])
  })

  it('matches any selected capability', () => {
    const result = filterAndSortAgents(agents, {
      ...DEFAULT_FILTERS,
      capabilities: ['research', 'audit'],
    })
    expect(result.map((a) => a.id).sort()).toEqual(['a1', 'a3'])
  })

  it('filters by price range', () => {
    const result = filterAndSortAgents(agents, {
      ...DEFAULT_FILTERS,
      priceMin: 0.6,
      priceMax: 1.0,
    })
    expect(result.map((a) => a.id)).toEqual(['a3'])
  })

  it('filters by status', () => {
    const result = filterAndSortAgents(agents, { ...DEFAULT_FILTERS, status: 'inactive' })
    expect(result.map((a) => a.id)).toEqual(['a3'])
  })

  it('sorts by price ascending', () => {
    const result = filterAndSortAgents(agents, {
      ...DEFAULT_FILTERS,
      sortKey: 'price',
      sortDir: 'asc',
    })
    expect(result.map((a) => a.price)).toEqual([0.5, 0.8, 1.2])
  })

  it('sorts by price descending', () => {
    const result = filterAndSortAgents(agents, {
      ...DEFAULT_FILTERS,
      sortKey: 'price',
      sortDir: 'desc',
    })
    expect(result.map((a) => a.price)).toEqual([1.2, 0.8, 0.5])
  })

  it('sorts by reputation descending', () => {
    const result = filterAndSortAgents(agents, {
      ...DEFAULT_FILTERS,
      sortKey: 'reputation',
      sortDir: 'desc',
    })
    expect(result.map((a) => a.reputation)).toEqual([4.9, 4.8, 4.2])
  })

  it('does not mutate the input array', () => {
    const copy = [...agents]
    filterAndSortAgents(agents, { ...DEFAULT_FILTERS, sortKey: 'price', sortDir: 'asc' })
    expect(agents).toEqual(copy)
  })
})

describe('URL query-string serialization', () => {
  it('round-trips a full filter set', () => {
    const filters: AgentFilters = {
      capabilities: ['research', 'coding'],
      priceMin: 0.2,
      priceMax: 1.5,
      status: 'active',
      sortKey: 'reputation',
      sortDir: 'desc',
    }
    const params = new URLSearchParams(filtersToSearchParams(filters))
    expect(filtersFromSearchParams(params)).toEqual(filters)
  })

  it('omits default values from the query string', () => {
    expect(filtersToSearchParams(DEFAULT_FILTERS)).toEqual({})
  })

  it('parses an empty query string into defaults', () => {
    expect(filtersFromSearchParams(new URLSearchParams())).toEqual(DEFAULT_FILTERS)
  })
})
