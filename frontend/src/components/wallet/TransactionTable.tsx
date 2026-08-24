import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ExternalLink, ArrowUpRight, ArrowDownRight, Clock } from 'lucide-react'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'
import styles from './TransactionTable.module.css'
import { formatDate } from '../../utils/format'

const STELLAR_EXPLORER = 'https://stellar.expert/explorer/testnet'

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

  return (
    <div className={styles.container}>
      <h3 className={styles.heading}>{t('wallet.tx.heading')}</h3>
      <div className={styles.table}>
        <div className={styles.header}>
          <span className={styles.colDirection}>{t('wallet.tx.type')}</span>
          <span className={styles.colAmount}>{t('wallet.tx.amount')}</span>
          <span className={styles.colCounterparty}>{t('wallet.tx.counterparty')}</span>
          <span className={styles.colMemo}>{t('wallet.tx.memo')}</span>
          <span className={styles.colTime}>{t('wallet.tx.time')}</span>
          <span className={styles.colTx}>{t('wallet.tx.tx')}</span>
        </div>
        {transactions.map((tx) => (
          <div key={tx.txHash} className={styles.row}>
            <span className={styles.colDirection}>
              {tx.direction === 'in' ? (
                <span className={styles.incoming}>
                  <ArrowDownRight size={14} />
                  {t('wallet.tx.in')}
                </span>
              ) : (
                <span className={styles.outgoing}>
                  <ArrowUpRight size={14} />
                  {t('wallet.tx.out')}
                </span>
              )}
            </span>
            <span
              className={`${styles.colAmount} ${
                tx.direction === 'in' ? styles.amountIn : styles.amountOut
              }`}
            >
              {tx.direction === 'in' ? '+' : '-'}
              {parseFloat(tx.amount).toFixed(7)} XLM
            </span>
            <span className={styles.colCounterparty} title={tx.counterparty}>
              {truncateAddress(tx.counterparty)}
            </span>
            <span className={styles.colMemo}>
              {tx.memo ? (
                <span className={styles.memoText}>{tx.memo}</span>
              ) : (
                <span className={styles.noMemo}>—</span>
              )}
            </span>
            <span className={styles.colTime}>{formatTimestamp(tx.timestamp, t, i18n.language)}</span>
            <span className={styles.colTx}>
              <a
                href={`${STELLAR_EXPLORER}/tx/${tx.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.txLink}
                title={t('a11y.viewOnStellarExplorer')}
              >
                <ExternalLink size={14} />
              </a>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
