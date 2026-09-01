import { useTranslation } from 'react-i18next'
import type { AgentRecord } from '../../types/api'
import type { SortDir, SortKey } from '../../utils/agentRegistry'
import { ReputationStars } from './ReputationStars'
import { DataTable, type DataTableColumn } from '../common/DataTable'
import { EmptyState } from '../common/EmptyState'
import { Users, Plus } from 'lucide-react'
import styles from './AgentTable.module.css'

interface AgentTableProps {
  agents: AgentRecord[]
  loading: boolean
  sortKey: SortKey | null
  sortDir: SortDir
  /** Toggle/apply sort on the given column. Reputation only sorts desc. */
  onSort: (key: SortKey) => void
  onRowClick: (agent: AgentRecord) => void
}

const SKELETON_ROWS = 5

function truncateId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}


export function AgentTable({
  agents,
  loading,
  sortKey: _sortKey,
  sortDir: _sortDir,
  onSort: _onSort,
  onRowClick,
}: AgentTableProps) {
  const { t } = useTranslation()

  const columns: DataTableColumn<AgentRecord>[] = [
    { key: 'id', header: t('agent.table.agentId'), render: (agent) => <span className={styles.mono} title={agent.id}>{truncateId(agent.id)}</span>, sortable: false },
    { key: 'capabilities', header: t('common.capabilities'), render: (agent) => (
      <span className={styles.pills}>
        {agent.capabilities.length === 0 ? <span className={styles.noPill}>—</span> : agent.capabilities.map((cap) => <span key={cap} className={styles.pill}>{cap}</span>)}
      </span>
    ) },
    { key: 'price', header: t('agent.table.price'), sortable: true, render: (agent) => <span className={styles.price}>{agent.price.toFixed(2)}</span> },
    { key: 'reputation', header: t('common.reputation'), sortable: true, render: (agent) => <ReputationStars value={agent.reputation} /> },
    { key: 'status', header: t('common.status'), render: (agent) => (
      <span className={`${styles.status} ${agent.status === 'active' ? styles.statusActive : styles.statusInactive}`}>
        {t(`agent.status.${agent.status}`, { defaultValue: agent.status })}
      </span>
    ) },
    { key: 'actions', header: t('agent.table.actions'), render: (agent) => (
      <button type="button" className={styles.detailsButton} onClick={(e) => { e.stopPropagation(); onRowClick(agent) }}>
        {t('common.details')}
      </button>
    ) },
  ]

  if (loading) {
    return (
      <div className={styles.tableWrap}>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className={styles.skeletonRow} data-testid="agent-skeleton-row">
            {Array.from({ length: 6 }, (_, c) => <span key={c} className={styles.skeletonCell} />)}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={styles.tableWrap}>
      {agents.length === 0 ? (
        <EmptyState
          icon={<Users size={32} />}
          title={t('agent.table.emptyTitle')}
          description={t('agent.table.emptySubtext')}
          primaryAction={{
            label: t('landing.hero.startTask', { defaultValue: 'Submit Task' }),
            to: '/tasks/new',
            icon: <Plus size={16} />,
          }}
          data-testid="agents-empty"
        />
      ) : (
        <DataTable
          columns={columns}
          rows={agents}
          getRowKey={(agent) => agent.id}
          getRowTestId={(agent) => `agent-row-${agent.id}`}
          maxHeight={540}
          stickyHeader
          onSort={(key) => onSort(key as SortKey)}
          onRowClick={onRowClick}
          rowClassName={() => styles.row}
        />
      )}
    </div>
  )
}
