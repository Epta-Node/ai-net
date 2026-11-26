import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ExternalLink, ArrowUpRight, ArrowDownRight, Clock, Search, CreditCard, Send, Loader2 } from 'lucide-react'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'
import { filterTransactions, computeRunningTotal } from '../../hooks/useTransactionHistory'
import styles from './TransactionTable.module.css'
import { formatDate } from '../../utils/format'
import { ExportButton } from './ExportButton'
import { DataTable, type DataTableColumn } from '../common/DataTable'
import { SkeletonTable } from '../common/Skeleton'
import EmptyState from '../common/EmptyState'
import { useSelectTypeahead } from '../../hooks/useSelectTypeahead'

const STELLAR_EXPLORER = 'https://stellar.expert/explorer/testnet'
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const

interface TransactionTableProps {
  transactions: TransactionEvent[]
  loading: boolean
  publicKey: string | null
}

function formatTimestamp(ts: string, t: TFunction, locale: string): string {
  const date = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return t('wallet.tx.justNow')
  if (diffMins < 60) return t('wallet.tx.minutesAgo', { minutes: diffMins })

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return t('wallet.tx.hoursAgo', { hours: diffHours })

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return t('wallet.tx.daysAgo', { days: diffDays })

  return formatDate(date, locale)
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`
}

export function TransactionTable({ transactions, loading, publicKey }: TransactionTableProps) {
  const { t, i18n } = useTranslation()
  const { showToast } = useToast()
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [pageSize, setPageSize] = useState<number>(25)
  const [page, setPage] = useState(1)

  const filtered = useMemo(
    () => filterTransactions(transactions, { search, from: dateFrom || null, to: dateTo || null }),
    [transactions, search, dateFrom, dateTo]
  )

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pageItems = useMemo(
    () => filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filtered, currentPage, pageSize]
  )
  const runningTotal = useMemo(() => computeRunningTotal(filtered), [filtered])

  const resetToFirstPage = () => setPage(1)

  if (!publicKey) {
    return (
      <div className={styles.container}>
        <h3 className={styles.heading}>{t('wallet.tx.heading')}</h3>
        <p className={styles.empty}>{t('wallet.tx.connectPrompt')}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className={styles.container}>
        <h3 className={styles.heading}>{t('wallet.tx.heading')}</h3>
        <SkeletonTable rows={5} columns={5} />
      </div>
    )
  }

  if (transactions.length === 0) {
    return (
      <div className={styles.container}>
        <h3 className={styles.heading}>{t('wallet.tx.heading')}</h3>
        <EmptyState
          icon={<CreditCard size={32} />}
          title={t('wallet.tx.empty')}
          description={t('wallet.tx.emptySubtext')}
          primaryAction={{
            label: 'Send XLM',
            onClick: () => {
              const el = document.getElementById('btn-send-xlm')
              if (el) el.scrollIntoView({ behavior: 'smooth' })
            },
            icon: <Send size={16} />,
          }}
          headingLevel={4}
          variant="card"
        />
      </div>
    )
  }

  const columns: DataTableColumn<TransactionEvent>[] = [
    {
      key: 'direction',
      header: t('wallet.tx.type'),
      render: (tx) => (
        tx.direction === 'in' ? (
          <span className={styles.incoming}><ArrowDownRight size={14} /> {t('wallet.tx.in')}</span>
        ) : (
          <span className={styles.outgoing}><ArrowUpRight size={14} /> {t('wallet.tx.out')}</span>
        )
      ),
      sortable: true,
      width: '10%',
    },
    {
      key: 'status',
      header: t('wallet.tx.status', 'Status'),
      render: (tx) => {
        const isPending = tx.status === 'pending';
        const isFailed = tx.status === 'failed';
        if (isPending) {
          return (
            <span
              className={`${styles.statusBadge} ${styles.statusPending}`}
              title={t('wallet.tx.pendingTooltip', 'Transaction is pending confirmation on the Stellar network')}
              data-testid="tx-status-pending"
            >
              <Loader2 size={12} className={styles.spin} />
              <span>{t('wallet.tx.pending', 'Pending')}</span>
            </span>
          );
        }
        if (isFailed) {
          return (
            <span
              className={`${styles.statusBadge} ${styles.statusFailed}`}
              title={t('wallet.tx.failedTooltip', 'Transaction failed')}
              data-testid="tx-status-failed"
            >
              <span>{t('wallet.tx.failed', 'Failed')}</span>
            </span>
          );
        }
        return (
          <span
            className={`${styles.statusBadge} ${styles.statusCompleted}`}
            title={t('wallet.tx.completedTooltip', 'Transaction completed')}
            data-testid="tx-status-completed"
          >
            <span>{t('wallet.tx.completed', 'Completed')}</span>
          </span>
        );
      },
      sortable: true,
      width: '14%',
    },
    {
      key: 'amount',
      header: t('wallet.tx.amount'),
      sortable: true,
      render: (tx) => (
        <span className={`${styles.colAmount} ${tx.direction === 'in' ? styles.amountIn : styles.amountOut}`}>
          {tx.direction === 'in' ? '+' : '-'}{parseFloat(tx.amount).toFixed(7)} XLM
        </span>
      ),
      width: '14%',
    },
    {
      key: 'counterparty',
      header: t('wallet.tx.counterparty'),
      render: (tx) => <span title={tx.counterparty}>{truncateAddress(tx.counterparty)}</span>,
      width: '18%',
    },
    {
      key: 'memo',
      header: t('wallet.tx.memo'),
      render: (tx) => (tx.memo ? <span className={styles.memoText}>{tx.memo}</span> : <span className={styles.noMemo}>-</span>),
      width: '18%',
    },
    {
      key: 'timestamp',
      header: t('wallet.tx.time'),
      sortable: true,
      render: (tx) => <span>{formatTimestamp(tx.timestamp, t, i18n.language)}</span>,
      width: '18%',
    },
    {
      key: 'txHash',
      header: t('wallet.tx.tx'),
      render: (tx) => (
        <a href={`${STELLAR_EXPLORER}/tx/${tx.txHash}`} target="_blank" rel="noopener noreferrer" className={styles.txLink} title={t('a11y.viewOnStellarExplorer')}>
          <ExternalLink size={14} />
        </a>
      ),
      width: '8%',
    },
  ]

  return (
    <div className={styles.container}>
      <div className={styles.toolbarHeader}>
        <h3 className={styles.heading}>{t('wallet.tx.heading')}</h3>
        <ExportButton transactions={filtered} publicKey={publicKey} />
      </div>

      <div className={styles.toolbar}>
        <div className={styles.searchField}>
          <Search size={14} className={styles.searchIcon} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder={t('wallet.tx.searchPlaceholder')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              resetToFirstPage()
            }}
            aria-label={t('wallet.tx.searchPlaceholder')}
          />
        </div>
        <div className={styles.dateFilters}>
          <label className={styles.dateLabel}>
            {t('wallet.tx.from')}
            <input
              type="date"
              className={styles.dateInput}
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => {
                setDateFrom(e.target.value)
                resetToFirstPage()
              }}
            />
          </label>
          <label className={styles.dateLabel}>
            {t('wallet.tx.to')}
            <input
              type="date"
              className={styles.dateInput}
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => {
                setDateTo(e.target.value)
                resetToFirstPage()
              }}
            />
          </label>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <Clock size={32} className={styles.emptyIcon} />
          <p>{t('wallet.tx.noMatches')}</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={pageItems}
          getRowKey={(tx) => tx.txHash}
          maxHeight={520}
          stickyHeader
          emptyState={<div className={styles.emptyState}><Clock size={32} className={styles.emptyIcon} /><p>{t('wallet.tx.noMatches')}</p></div>}
        />
      )}

      {filtered.length > 0 && (
        <div className={styles.footer}>
          <div className={styles.pagination}>
            <label className={styles.pageSizeLabel}>
              {t('wallet.tx.perPage')}
              <select
                className={styles.pageSizeSelect}
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value))
                  resetToFirstPage()
                }}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.pageControls}>
              <button
                type="button"
                className={styles.pageButton}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
              >
                {t('wallet.tx.prev')}
              </button>
              <span className={styles.pageIndicator}>
                {t('wallet.tx.pageIndicator', { current: currentPage, total: totalPages })}
              </span>
              <button
                type="button"
                className={styles.pageButton}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
              >
                {t('wallet.tx.next')}
              </button>
            </div>
          </div>
          <div className={styles.runningTotal}>
            {t('wallet.tx.runningTotal')}:{' '}
            <span className={runningTotal >= 0 ? styles.amountIn : styles.amountOut}>
              {runningTotal >= 0 ? '+' : ''}
              {runningTotal.toFixed(7)} XLM
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
