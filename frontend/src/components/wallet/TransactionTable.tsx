import { ExternalLink, ArrowUpRight, ArrowDownRight, Clock } from 'lucide-react'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'
import styles from './TransactionTable.module.css'

const STELLAR_EXPLORER = 'https://stellar.expert/explorer/testnet'

interface TransactionTableProps {
  transactions: TransactionEvent[]
  loading: boolean
  publicKey: string | null
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString()
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`
}

export function TransactionTable({ transactions, loading, publicKey }: TransactionTableProps) {
  if (!publicKey) {
    return (
      <div className={styles.container}>
        <h3 className={styles.heading}>Transaction History</h3>
        <p className={styles.empty}>Connect your wallet to view transaction history.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className={styles.container}>
        <h3 className={styles.heading}>Transaction History</h3>
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
        <h3 className={styles.heading}>Transaction History</h3>
        <div className={styles.emptyState}>
          <Clock size={32} className={styles.emptyIcon} />
          <p>No transactions yet</p>
          <p className={styles.emptySubtext}>
            Your payment history will appear here once you send or receive XLM.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <h3 className={styles.heading}>Transaction History</h3>
      <div className={styles.table}>
        <div className={styles.header}>
          <span className={styles.colDirection}>Type</span>
          <span className={styles.colAmount}>Amount</span>
          <span className={styles.colCounterparty}>Counterparty</span>
          <span className={styles.colMemo}>Memo</span>
          <span className={styles.colTime}>Time</span>
          <span className={styles.colTx}>TX</span>
        </div>
        {transactions.map((tx) => (
          <div key={tx.txHash} className={styles.row}>
            <span className={styles.colDirection}>
              {tx.direction === 'in' ? (
                <span className={styles.incoming}>
                  <ArrowDownRight size={14} />
                  In
                </span>
              ) : (
                <span className={styles.outgoing}>
                  <ArrowUpRight size={14} />
                  Out
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
            <span className={styles.colTime}>{formatTimestamp(tx.timestamp)}</span>
            <span className={styles.colTx}>
              <a
                href={`${STELLAR_EXPLORER}/tx/${tx.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.txLink}
                title="View on Stellar Explorer"
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
