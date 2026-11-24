import { useTranslation } from 'react-i18next'
import React from 'react';
import type { AgentRecord } from '../../types/api';
import type { SortDir, SortKey } from '../../utils/agentRegistry';
import { ReputationStars } from './ReputationStars';
import { DataTable, type DataTableColumn, type SortDirection } from '../common/DataTable';
import { EmptyState } from '../common/EmptyState';
import { Users, Plus } from 'lucide-react';
import styles from './AgentTable.module.css';
import { SkeletonTable } from '../common/Skeleton';

interface AgentTableProps {
  agents: AgentRecord[];
  loading: boolean;
  sortKey: SortKey | null;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  onRowClick: (agent: AgentRecord) => void;
  /** #877: pagination */
  pageSize?: number;
}

const SKELETON_ROWS = 5;
// #877: default page sizes
const PAGE_SIZES = [10, 25, 50];

function truncateId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export function AgentTable({
  agents,
  loading,
  sortKey,
  sortDir,
  onSort,
  onRowClick,
  pageSize = 25,
}: AgentTableProps) {
  const { t } = useTranslation();
  // #877: pagination state
  const [page, setPage] = React.useState(0);
  const [size, setSize] = React.useState(pageSize);
  const totalPages = Math.max(1, Math.ceil(agents.length / size));

  // Keep the page index valid when filtering or fresh data shrinks the list.
  React.useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);

  const paged = agents.slice(page * size, (page + 1) * size);

  const columns: DataTableColumn<AgentRecord>[] = [
    {
      key: 'id',
      header: t('agent.table.agentId'),
      render: (agent) => (
        <span className={styles.mono} title={agent.id}>
          {truncateId(agent.id)}
        </span>
      ),
      sortable: false,
    },
    {
      key: 'capabilities',
      header: t('common.capabilities'),
      render: (agent) => (
        <span className={styles.pills}>
          {agent.capabilities.length === 0 ? (
            <span className={styles.noPill}>—</span>
          ) : (
            agent.capabilities.map((cap) => (
              <span key={cap} className={styles.pill}>
                {cap}
              </span>
            ))
          )}
        </span>
      ),
    },
    {
      key: 'price',
      header: t('agent.table.price'),
      sortable: true,
      render: (agent) => <span className={styles.price}>{agent.price.toFixed(2)}</span>,
    },
    {
      key: 'reputation',
      header: t('common.reputation'),
      sortable: true,
      render: (agent) => <ReputationStars value={agent.reputation} />,
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (agent) => (
        <span
          className={`${styles.status} ${agent.status === 'active' ? styles.statusActive : styles.statusInactive}`}
        >
          {t(`agent.status.${agent.status}`, { defaultValue: agent.status })}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('agent.table.actions'),
      render: (agent) => (
        <button
          type="button"
          className={styles.detailsButton}
          onClick={(e) => {
            e.stopPropagation();
            onRowClick(agent);
          }}
        >
          {t('common.details')}
        </button>
      ),
    },
  ];

  if (loading) {
    return (
      <div className={styles.tableWrap}>
        <SkeletonTable rows={SKELETON_ROWS} columns={6} rowTestId="agent-skeleton-row" />
      </div>
    );
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
          headingLevel={2}
          data-testid="agents-empty"
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={paged}
            getRowKey={(agent) => agent.id}
            getRowTestId={(agent) => `agent-row-${agent.id}`}
            caption={t('nav.agentRegistry')}
            maxHeight={540}
            stickyHeader
            sortKey={sortKey}
            sortDirection={sortDir as SortDirection}
            onSort={(key) => onSort(key as SortKey)}
            onRowClick={onRowClick}
            rowClassName={() => styles.row}
          />
          {/* #877: pagination controls */}
          {agents.length > size && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
              <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
              <span>Page {page + 1} of {totalPages}</span>
              <button type="button" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
              <select aria-label={t('page.agents.pageFilters')} value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }}>
                {PAGE_SIZES.map((s) => <option key={s} value={s}>{s} / page</option>)}
              </select>
            </div>
          )}
        </>
      )}
    </div>
  );
}
