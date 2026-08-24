import React, { useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Inbox, ChevronDown, ChevronUp } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import type { AgentRecord } from '../../types/api'
import type { SortDir } from '../../utils/agentRegistry'
import { ReputationStars } from './ReputationStars'
import { AgentDetailModal } from './AgentDetailModal'
import { useTableSort } from '../../hooks/useTableSort'
import styles from './AgentTable.module.css'

interface AgentTableProps {
  agents: AgentRecord[]
  loading: boolean
  selectedIds: Set<string>
  onToggleSelection: (id: string, shift: boolean) => void
  onSelectAll: (selected: boolean) => void
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
  selectedIds,
  onToggleSelection,
  onSelectAll,
}: AgentTableProps) {
  const { sortKey, sortDir, handleSort } = useTableSort()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const allSelected = agents.length > 0 && selectedIds.size === agents.length
  const someSelected = selectedIds.size > 0 && !allSelected

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} id="agent-table">
        <thead>
          <tr>
            <th className={styles.checkboxCell}>
              <input
                type="checkbox"
                checked={allSelected}
                ref={(input) => {
                  if (input) input.indeterminate = someSelected
                }}
                onChange={(e) => onSelectAll(e.target.checked)}
                aria-label="Select all agents"
              />
            </th>
            <th>Agent ID</th>
            <th>Capabilities</th>
            <th>
              <button
                type="button"
                className={styles.sortButton}
                onClick={() => handleSort('price')}
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
                onClick={() => handleSort('reputation')}
                aria-label="Sort by reputation"
              >
                Reputation
                <SortIcon active={sortKey === 'reputation'} dir={sortDir} />
              </button>
            </th>
            <th>Status</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <tr key={i} className={styles.skeletonRow} data-testid="agent-skeleton-row">
                <td className={styles.checkboxCell}>
                  <span className={styles.skeletonCell} />
                </td>
                {Array.from({ length: 6 }, (_, c) => (
                  <td key={c}>
                    <span className={styles.skeletonCell} />
                  </td>
                ))}
              </tr>
            ))
          ) : agents.length === 0 ? (
            <tr>
              <td colSpan={7}>
                <div className={styles.emptyState} data-testid="agents-empty">
                  <Inbox size={32} className={styles.emptyIcon} aria-hidden="true" />
                  <p className={styles.emptyTitle}>No agents found</p>
                  <p className={styles.emptySubtext}>
                    No registered agents match your filters.
                  </p>
                  <button className={styles.ctaButton}>Register Agent</button>
                </div>
              </td>
            </tr>
          ) : (
            agents.map((agent) => {
              const isSelected = selectedIds.has(agent.id)
              const isExpanded = expandedId === agent.id

              return (
                <React.Fragment key={agent.id}>
                  <tr
                    className={`${styles.row} ${isSelected ? styles.rowSelected : ''} ${isExpanded ? styles.rowExpanded : ''}`}
                    data-testid={`agent-row-${agent.id}`}
                    onClick={() => setExpandedId(isExpanded ? null : agent.id)}
                    tabIndex={0}
                    role="button"
                    aria-label={`View details for ${agent.name}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setExpandedId(isExpanded ? null : agent.id)
                      } else if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        const next = e.currentTarget.nextElementSibling as HTMLElement
                        if (next) next.focus()
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        const prev = e.currentTarget.previousElementSibling as HTMLElement
                        if (prev) prev.focus()
                      }
                    }}
                  >
                    <td className={styles.checkboxCell} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          // Note: React's synthetic event might have shiftKey on the nativeEvent
                          onToggleSelection(agent.id, (e.nativeEvent as MouseEvent).shiftKey)
                        }}
                        aria-label={`Select agent ${agent.name}`}
                      />
                    </td>
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
                        className={styles.expandButton}
                        onClick={(e) => {
                          e.stopPropagation()
                          setExpandedId(isExpanded ? null : agent.id)
                        }}
                        aria-expanded={isExpanded}
                        aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                      >
                        {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </button>
                    </td>
                  </tr>
                  <AnimatePresence>
                    {isExpanded && (
                      <tr className={styles.expandedRowContainer}>
                        <td colSpan={7} className={styles.expandedCell}>
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className={styles.expandedContent}
                          >
                            <AgentDetailModal agent={agent} inline={true} onClose={() => setExpandedId(null)} />
                          </motion.div>
                        </td>
                      </tr>
                    )}
                  </AnimatePresence>
                </React.Fragment>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
