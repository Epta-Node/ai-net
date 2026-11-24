import type { TransactionEvent } from '../hooks/useTransactionHistory'

export type TransactionType = 'payment' | 'escrow_lock' | 'escrow_release'

export interface Transaction {
  date?: string | Date
  timestamp?: string | Date
  type?: TransactionType | string
  from_wallet?: string
  to_wallet?: string
  amount_xlm?: string | number
  amount?: string | number
  direction?: 'in' | 'out'
  counterparty?: string
  task_id?: string
  memo?: string
  status?: string
  stellar_tx_hash?: string
  txHash?: string
}

export interface CsvExportOptions {
  dateRange?: { from: Date; to: Date }
  types?: ('payment' | 'escrow_lock' | 'escrow_release')[]
  maxRows?: number // default: 10_000; warn if truncated
}

const DEFAULT_MAX_ROWS = 10_000

/**
 * Escapes cell value to be safe against CSV injection (formula injection).
 * Quotes the string and doubles internal double quotes.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '""'
  const str = String(value)
  // Quoting alone does not stop spreadsheet formula evaluation.
  // Force dangerous prefix cells to be interpreted as text by prepending a single quote.
  const safe = /^\s*[=+@-]/u.test(str) || /^\s*[\t\r\n]/u.test(str)
    ? `'${str}`
    : str
  return `"${safe.replace(/"/g, '""')}"`
}

/**
 * Formats a timestamp into an ISO 8601 date string.
 */
function toIsoDate(val: string | Date | undefined): string {
  if (!val) return new Date().toISOString()
  const d = typeof val === 'string' ? new Date(val) : val
  return isNaN(d.getTime()) ? String(val) : d.toISOString()
}

/**
 * Serializes transactions into CSV format matching the exact spec (#821).
 * Columns: date, type, from_wallet, to_wallet, amount_xlm, task_id, status, stellar_tx_hash
 */
export function transactionsToCSV(
  txs: (Transaction | TransactionEvent)[],
  opts: CsvExportOptions = {}
): string {
  const { dateRange, types, maxRows = DEFAULT_MAX_ROWS } = opts

  let filtered = [...txs]

  // Filter by dateRange
  if (dateRange?.from || dateRange?.to) {
    filtered = filtered.filter((tx) => {
      const rawDate = 'date' in tx && tx.date ? tx.date : ('timestamp' in tx ? tx.timestamp : undefined)
      if (!rawDate) return true
      const d = new Date(rawDate)
      if (isNaN(d.getTime())) return true
      if (dateRange.from && d < dateRange.from) return false
      if (dateRange.to && d > dateRange.to) return false
      return true
    })
  }

  // Filter by types
  if (types && types.length > 0) {
    filtered = filtered.filter((tx) => {
      const txType: TransactionType = ('type' in tx && tx.type
        ? (tx.type as TransactionType)
        : 'payment')
      return types.includes(txType)
    })
  }

  // Check truncation
  if (filtered.length > maxRows) {
    console.warn(`CSV export truncated from ${filtered.length} to ${maxRows} rows.`)
    filtered = filtered.slice(0, maxRows)
  }

  const headers = [
    'date',
    'type',
    'from_wallet',
    'to_wallet',
    'amount_xlm',
    'task_id',
    'status',
    'stellar_tx_hash',
  ]

  const rows = filtered.map((tx) => {
    const rawDate = 'date' in tx && tx.date ? tx.date : ('timestamp' in tx ? tx.timestamp : undefined)
    const date = toIsoDate(rawDate)
    const type = 'type' in tx && tx.type ? String(tx.type) : 'payment'
    const from_wallet =
      'from_wallet' in tx && tx.from_wallet
        ? tx.from_wallet
        : 'direction' in tx && tx.direction === 'in'
          ? tx.counterparty ?? ''
          : ''
    const to_wallet =
      'to_wallet' in tx && tx.to_wallet
        ? tx.to_wallet
        : 'direction' in tx && tx.direction === 'out'
          ? tx.counterparty ?? ''
          : ''
    const amount_xlm =
      'amount_xlm' in tx && tx.amount_xlm !== undefined
        ? String(tx.amount_xlm)
        : 'amount' in tx && tx.amount !== undefined
          ? String(tx.amount)
          : '0'
    const task_id = 'task_id' in tx && tx.task_id ? tx.task_id : ('memo' in tx && tx.memo ? tx.memo : '')
    const status = 'status' in tx && tx.status ? String(tx.status) : 'success'
    const stellar_tx_hash =
      'stellar_tx_hash' in tx && tx.stellar_tx_hash
        ? tx.stellar_tx_hash
        : 'txHash' in tx && tx.txHash
          ? tx.txHash
          : ''

    return [
      date,
      type,
      from_wallet,
      to_wallet,
      amount_xlm,
      task_id,
      status,
      stellar_tx_hash,
    ].map(escapeCsvCell)
  })

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n')
}

/**
 * Chunked CSV generation using requestIdleCallback for large datasets (#821).
 */
export async function buildCsvInChunks(
  txs: (Transaction | TransactionEvent)[],
  opts: CsvExportOptions = {},
  onProgress?: (percent: number) => void,
  chunkSize = 1000
): Promise<string> {
  const total = txs.length
  if (total <= chunkSize) {
    onProgress?.(100)
    return transactionsToCSV(txs, opts)
  }

  // Pre-filter
  const { dateRange, types, maxRows = DEFAULT_MAX_ROWS } = opts
  let filtered = [...txs]
  if (dateRange?.from || dateRange?.to) {
    filtered = filtered.filter((tx) => {
      const rawDate = 'date' in tx && tx.date ? tx.date : ('timestamp' in tx ? tx.timestamp : undefined)
      if (!rawDate) return true
      const d = new Date(rawDate)
      if (isNaN(d.getTime())) return true
      if (dateRange.from && d < dateRange.from) return false
      if (dateRange.to && d > dateRange.to) return false
      return true
    })
  }
  if (types && types.length > 0) {
    filtered = filtered.filter((tx) => {
      const txType: TransactionType = ('type' in tx && tx.type ? (tx.type as TransactionType) : 'payment')
      return types.includes(txType)
    })
  }
  if (filtered.length > maxRows) {
    filtered = filtered.slice(0, maxRows)
  }

  const rows: string[] = []
  let index = 0

  return new Promise((resolve) => {
    function processChunk() {
      const end = Math.min(index + chunkSize, filtered.length)
      const chunk = filtered.slice(index, end)
      const csvChunk = transactionsToCSV(chunk, { maxRows: chunkSize })
      // strip headers after first chunk
      const lines = csvChunk.split('\r\n')
      if (index === 0) {
        rows.push(...lines)
      } else {
        rows.push(...lines.slice(1))
      }

      index = end
      onProgress?.(Math.round((index / filtered.length) * 100))

      if (index < filtered.length) {
        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
          window.requestIdleCallback(processChunk)
        } else {
          setTimeout(processChunk, 0)
        }
      } else {
        resolve(rows.join('\r\n'))
      }
    }

    processChunk()
  })
}

/**
 * Backward compatibility alias for existing callers.
 */
export function toCsv(transactions: TransactionEvent[]): string {
  const header = ['Date', 'Direction', 'Amount (XLM)', 'Counterparty', 'Memo', 'Transaction Hash']
  const rows = transactions.map((tx) => [
    tx.timestamp, tx.direction, tx.amount, tx.counterparty, tx.memo ?? '', tx.txHash,
  ])
  return [header, ...rows].map((row) => row.map((cell) => escapeCsvCell(String(cell))).join(',')).join('\r\n')
}
