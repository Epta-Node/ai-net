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
} from '../utils/agentRegistry'
import styles from './AgentsPage.module.css'

import { useRowSelection } from '../hooks/useRowSelection'

function AgentsPage() {
  const { agents, loading, error, refetch } = useAgentRegistry()
  const [searchParams, setSearchParams] = useSearchParams()
  const [selected, setSelected] = useState<AgentRecord | null>(null)

  const { selectedIds, toggleSelection, selectAll, clearSelection } = useRowSelection(agents, (a) => a.id)

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
            selectedCount={selectedIds.size}
            onClearSelection={clearSelection}
          />

          <AgentTable
            agents={visibleAgents}
            loading={loading}
            selectedIds={selectedIds}
            onToggleSelection={toggleSelection}
            onSelectAll={selectAll}
          />
        </>
      )}

      <AgentDetailModal agent={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

export default AgentsPage
