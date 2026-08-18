import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAgentRegistry } from '../hooks/useAgentRegistry'
import { AgentTable } from '../components/agents/AgentTable'
import { AgentFilterBar } from '../components/agents/AgentFilterBar'
import { AgentDetailModal } from '../components/agents/AgentDetailModal'
import type { AgentRecord } from '../types/api'
import {
  allCapabilities,
  filterAndSortAgents,
  filtersFromSearchParams,
  filtersToSearchParams,
  priceDomain,
  type AgentFilters,
  type SortKey,
} from '../utils/agentRegistry'
import styles from './AgentsPage.module.css'

function AgentsPage() {
  const { agents, loading, error, refetch } = useAgentRegistry()
  const [searchParams, setSearchParams] = useSearchParams()
  const [selected, setSelected] = useState<AgentRecord | null>(null)

  // Filter/sort state is derived from the URL so views are shareable.
  const filters = useMemo(
    () => filtersFromSearchParams(searchParams),
    [searchParams]
  )

  const updateFilters = useCallback(
    (next: Partial<AgentFilters>) => {
      const merged = { ...filters, ...next }
      setSearchParams(filtersToSearchParams(merged), { replace: true })
    },
    [filters, setSearchParams]
  )

  const resetFilters = useCallback(() => {
    setSearchParams({}, { replace: true })
  }, [setSearchParams])

  const handleSort = useCallback(
    (key: SortKey) => {
      if (filters.sortKey !== key) {
        // Reputation defaults to high-to-low; price to low-to-high.
        updateFilters({ sortKey: key, sortDir: key === 'price' ? 'asc' : 'desc' })
      } else {
        updateFilters({ sortDir: filters.sortDir === 'asc' ? 'desc' : 'asc' })
      }
    },
    [filters, updateFilters]
  )

  const capabilities = useMemo(() => allCapabilities(agents), [agents])
  const domain = useMemo(() => priceDomain(agents), [agents])
  const visibleAgents = useMemo(
    () => filterAndSortAgents(agents, filters),
    [agents, filters]
  )

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Agent Registry</h1>
          <p className={styles.subtitle}>
            {loading
              ? 'Loading registered agents…'
              : `${visibleAgents.length} of ${agents.length} agent${
                  agents.length === 1 ? '' : 's'
                }`}
          </p>
        </div>
      </div>

      {error && !loading ? (
        <div className={styles.errorBox} id="registry-error" role="alert">
          <p>Failed to load the agent registry: {error}</p>
          <button type="button" className={styles.retryButton} onClick={refetch}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <AgentFilterBar
            filters={filters}
            availableCapabilities={capabilities}
            priceDomain={domain}
            onChange={updateFilters}
            onReset={resetFilters}
            onRefresh={refetch}
          />

          <AgentTable
            agents={visibleAgents}
            loading={loading}
            sortKey={filters.sortKey}
            sortDir={filters.sortDir}
            onSort={handleSort}
            onRowClick={setSelected}
          />
        </>
      )}

      <AgentDetailModal agent={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

export default AgentsPage
