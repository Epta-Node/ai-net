import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useAgentRegistry } from '../hooks/useAgentRegistry'
import { AgentTable } from '../components/agents/AgentTable'
import { AgentFilterBar } from '../components/agents/AgentFilterBar'
import { AgentDetailModal } from '../components/agents/AgentDetailModal'
import { Skeleton, SkeletonTable } from '../components/common/Skeleton'
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

const TABLE_COLUMNS = 6
const SKELETON_ROWS = 5

/**
 * Context-aware skeleton that mirrors the filter bar and agent table layout
 * so there is no layout shift between the loading and loaded states.
 */
export function AgentsPageSkeleton() {
  const { t } = useTranslation()

  return (
    <div data-testid="agents-page-skeleton" aria-busy="true" aria-label={t('a11y.loadingAgentRegistry')}>
      <div className={styles.filterSkeleton}>
        <div className={styles.filterGroupSkeleton}>
          <Skeleton width="6rem" height="0.75rem" />
          <div className={styles.chipRow}>
            <Skeleton variant="pill" width="5rem" height="1.5rem" />
            <Skeleton variant="pill" width="5rem" height="1.5rem" />
            <Skeleton variant="pill" width="5rem" height="1.5rem" />
          </div>
        </div>
        <div className={styles.filterGroupSkeleton}>
          <Skeleton width="8rem" height="0.75rem" />
          <Skeleton width="10rem" height="0.4rem" />
        </div>
      </div>

      <div className={styles.tableSkeleton}>
        <div className={styles.tableHeaderRow} aria-hidden="true">
          {Array.from({ length: TABLE_COLUMNS }, (_, i) => (
            <Skeleton key={i} height="1rem" />
          ))}
        </div>
        <SkeletonTable rows={SKELETON_ROWS} columns={TABLE_COLUMNS} />
      </div>
    </div>
  )
}

function AgentsPage() {
  const { t } = useTranslation()
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
          <h1 className={styles.title}>{t('nav.agentRegistry')}</h1>
          <p className={styles.subtitle}>
            {loading
              ? t('page.agents.loading')
              : `${visibleAgents.length} of ${agents.length} agent${
                  agents.length === 1 ? '' : 's'
                }`}
          </p>
        </div>
      </div>

      {error && !loading ? (
        <div className={styles.errorBox} id="registry-error" role="alert">
          <p>{t('page.agents.error', { error })}</p>
          <button type="button" className={styles.retryButton} onClick={refetch}>
            {t('common.retry')}
          </button>
        </div>
      ) : loading && agents.length === 0 ? (
        <AgentsPageSkeleton />
      ) : (
        <div className="fade-in">
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
        </div>
      )}

      <AgentDetailModal agent={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

export default AgentsPage
