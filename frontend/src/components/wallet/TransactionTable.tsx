import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ExternalLink, ArrowUpRight, ArrowDownRight, Clock, Search } from 'lucide-react'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'
import { filterTransactions, computeRunningTotal } from '../../hooks/useTransactionHistory'
import styles from './TransactionTable.module.css'
import { formatDate } from '../../utils/format'
import { ExportButton } from './ExportButton'
import { DataTable, type DataTableColumn } from '../common/DataTable'

const STELLAR_EXPLORER = 'https://stellar.expert/explorer/testnet'
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const

interface TransactionTableProps {
  transactions: TransactionEvent[]
  loading: boolean
  publicKey: string | null
}

// Takes `t` and the locale as arguments rather than becoming a hook, so it
// stays a plain pure function that is easy to reason about and test.
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

  // Any change that narrows/widens the result set can strand the user on a page
  // past the new end, so every filter/page-size change snaps back to page 1.
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
        <div className={styles.skeletonList}>
          {[1, 2, 3].map((i) => (
            <div key={i} className={styles.skeletonRow}>
              <div className={styles.skeletonIcon} />
              <div className={styles.skeletonLine} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (transactions.length === 0) {
    return (
      <div className={styles.container}>
        <h3 className={styles.heading}>{t('wallet.tx.heading')}</h3>
        <div className={styles.emptyState}>
          <Clock size={32} className={styles.emptyIcon} />
          <p>{t('wallet.tx.empty')}</p>
          <p className={styles.emptySubtext}>
            {t('wallet.tx.emptySubtext')}
          </p>
        </div>
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
      width: '12%',
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
      width: '16%',
    },
    {
      key: 'counterparty',
      header: t('wallet.tx.counterparty'),
      render: (tx) => <span title={tx.counterparty}>{truncateAddress(tx.counterparty)}</span>,
      width: '20%',
    },
    {
      key: 'memo',
      header: t('wallet.tx.memo'),
      render: (tx) => (tx.memo ? <span className={styles.memoText}>{tx.memo}</span> : <span className={styles.noMemo}>—</span>),
      width: '22%',
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

      <div className={styles.pagination}>
        <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>
          Previous
        </button>
        <span>
          Page {currentPage} of {totalPages}
        </span>
        <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
          Next
        </button>
      </div>
      <div className={styles.runningTotal}>
        {t('wallet.tx.total')} {runningTotal > 0 ? '+' : ''}{runningTotal.toFixed(7)} XLM
      </div>
    </div>
  )
}            </span>
          </div>
        ))}
      </div>
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
