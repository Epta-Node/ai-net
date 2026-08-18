import { ArrowDown, ArrowUp, ArrowUpDown, Inbox } from 'lucide-react'
import type { AgentRecord } from '../../types/api'
import type { SortDir, SortKey } from '../../utils/agentRegistry'
import { ReputationStars } from './ReputationStars'
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

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ArrowUpDown size={12} aria-hidden="true" />
  return dir === 'asc' ? (
    <ArrowUp size={12} aria-hidden="true" />
  ) : (
    <ArrowDown size={12} aria-hidden="true" />
  )
}

export function AgentTable({
  agents,
  loading,
  sortKey,
  sortDir,
  onSort,
  onRowClick,
}: AgentTableProps) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} id="agent-table">
        <thead>
          <tr>
            <th>Agent ID</th>
            <th>Capabilities</th>
            <th>
              <button
                type="button"
                className={styles.sortButton}
                onClick={() => onSort('price')}
                aria-label="Sort by price"
              >
                Price (XLM)
                <SortIcon active={sortKey === 'price'} dir={sortDir} />
              </button>
            </th>
            <th>
              <button
                type="button"
                className={styles.sortButton}
                onClick={() => onSort('reputation')}
                aria-label="Sort by reputation"
              >
                Reputation
                <SortIcon active={sortKey === 'reputation'} dir={sortDir} />
              </button>
            </th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <tr key={i} className={styles.skeletonRow} data-testid="agent-skeleton-row">
                {Array.from({ length: 6 }, (_, c) => (
                  <td key={c}>
                    <span className={styles.skeletonCell} />
                  </td>
                ))}
              </tr>
            ))
          ) : agents.length === 0 ? (
            <tr>
              <td colSpan={6}>
                <div className={styles.emptyState} data-testid="agents-empty">
                  <Inbox size={32} className={styles.emptyIcon} aria-hidden="true" />
                  <p className={styles.emptyTitle}>No agents found</p>
                  <p className={styles.emptySubtext}>
                    No registered agents match your filters.
                  </p>
                </div>
              </td>
            </tr>
          ) : (
            agents.map((agent) => (
              <tr
                key={agent.id}
                className={styles.row}
                data-testid={`agent-row-${agent.id}`}
                onClick={() => onRowClick(agent)}
                tabIndex={0}
                role="button"
                aria-label={`View details for ${agent.name}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onRowClick(agent)
                  }
                }}
              >
                <td className={styles.mono} title={agent.id}>
                  {truncateId(agent.id)}
                </td>
                <td>
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
                </td>
                <td className={styles.price}>{agent.price.toFixed(2)}</td>
                <td>
                  <ReputationStars value={agent.reputation} />
                </td>
                <td>
                  <span
                    className={`${styles.status} ${
                      agent.status === 'active' ? styles.statusActive : styles.statusInactive
                    }`}
                  >
                    {agent.status}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className={styles.detailsButton}
                    onClick={(e) => {
                      e.stopPropagation()
                      onRowClick(agent)
                    }}
                  >
                    Details
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
