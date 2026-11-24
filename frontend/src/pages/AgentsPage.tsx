import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useAgentRegistry } from '../hooks/useAgentRegistry'
import { AgentTable } from '../components/agents/AgentTable'
import { AgentFilterBar } from '../components/agents/AgentFilterBar'
import { AgentFilters } from '../components/agents/AgentFilters'
import { AgentCard } from '../components/agents/AgentCard'
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
  type SortKey,
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
  const { agents, loading, error, refetch, fetching, isFirstPage, hasNextPage, firstPage, nextPage } = useAgentRegistry()
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

  const handleToggleCapability = useCallback(
    (cap: string) => {
      const nextCaps = filters.capabilities.includes(cap)
        ? filters.capabilities.filter((c) => c !== cap)
        : [...filters.capabilities, cap]
      updateFilters({ capabilities: nextCaps })
    },
    [filters.capabilities, updateFilters]
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
        <div className="fade-in space-y-4">
          <AgentFilters
            searchQuery={filters.query ?? ''}
            onSearchChange={(q) => updateFilters({ query: q })}
            selectedCapabilities={filters.capabilities}
            onToggleCapability={handleToggleCapability}
            availableCapabilities={capabilities}
            sortBy={filters.sortBy ?? 'relevance'}
            onSortChange={(sortBy) => updateFilters({ sortBy })}
            resultCount={visibleAgents.length}
            onReset={resetFilters}
          />

          <AgentFilterBar
            filters={filters}
            availableCapabilities={capabilities}
            priceDomain={domain}
            onChange={updateFilters}
            onReset={resetFilters}
            onRefresh={refetch}
          />

          {visibleAgents.length === 0 ? (
            <div
              data-testid="agents-empty"
              className="my-8 rounded-2xl border border-[var(--border-subtle,#262626)] bg-[var(--surface-sunken,#141414)] p-12 text-center"
            >
              <p className="text-base text-gray-300">
                {filters.query
                  ? `No agents match '${filters.query}'`
                  : t('page.agents.empty', 'No agents match your criteria')}
              </p>
              <button
                type="button"
                data-testid="clear-filters-btn"
                onClick={resetFilters}
                className="mt-4 rounded-xl bg-[var(--primary,#9333ea)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <>
              <div data-testid="agents-grid" className="my-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visibleAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    searchQuery={filters.query}
                    onClick={setSelected}
                  />
                ))}
              </div>

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
        </div>
      )}

      {!loading && (
        <nav className={styles.pagination} aria-label={t('page.agents.pagination')} aria-busy={fetching}>
          <span>{t('page.agents.pageFilters')}</span>
          <button type="button" onClick={firstPage} disabled={fetching || isFirstPage}>
            {t('page.agents.firstPage')}
          </button>
          <button type="button" onClick={nextPage} disabled={fetching || !hasNextPage}>
            {t('page.agents.nextPage')}
          </button>
        </nav>
      )}

      <AgentDetailModal agent={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

export default AgentsPage
