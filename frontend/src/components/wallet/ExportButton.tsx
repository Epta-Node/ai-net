import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileText, Table as TableIcon } from 'lucide-react'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'
import styles from './ExportButton.module.css'

interface ExportButtonProps {
  transactions: TransactionEvent[]
  publicKey: string
}

function toCsv(transactions: TransactionEvent[]): string {
  const header = ['Date', 'Direction', 'Amount (XLM)', 'Counterparty', 'Memo', 'Transaction Hash']
  const rows = transactions.map((tx) => [
    tx.timestamp, tx.direction, tx.amount, tx.counterparty, tx.memo ?? '', tx.txHash,
  ])
  const escapeCell = (value: string) => `"${value.replace(/"/g, '""')}"`
  return [header, ...rows].map((row) => row.map((cell) => escapeCell(String(cell))).join(',')).join('\r\n')
}

function downloadBlob(content: BlobPart, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function ExportButton({ transactions, publicKey }: ExportButtonProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleExportCsv = () => {
    downloadBlob(toCsv(transactions), `transactions-${Date.now()}.csv`, 'text/csv;charset=utf-8;')
    setOpen(false)
  }

  const handleExportPdf = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ])

      const doc = new jsPDF()
      const netTotal = transactions.reduce((sum, tx) => {
        const amount = parseFloat(tx.amount)
        return Number.isNaN(amount) ? sum : sum + (tx.direction === 'in' ? amount : -amount)
      }, 0)

      doc.setFontSize(14)
      doc.text(t('wallet.export.pdfTitle'), 14, 16)
      doc.setFontSize(9)
      doc.text(`${t('wallet.publicKey')}: ${publicKey}`, 14, 23)
      doc.text(`${t('wallet.export.generatedAt')}: ${new Date().toLocaleString()}`, 14, 28)
      doc.text(`${t('wallet.export.txCount')}: ${transactions.length}`, 14, 33)
      doc.text(`${t('wallet.tx.runningTotal')}: ${netTotal.toFixed(7)} XLM`, 14, 38)

      autoTable(doc, {
        startY: 44,
        head: [[
          t('wallet.tx.time'), t('wallet.tx.type'), t('wallet.tx.amount'),
          t('wallet.tx.counterparty'), t('wallet.tx.memo'), t('wallet.tx.tx'),
        ]],
        body: transactions.map((tx) => [
          new Date(tx.timestamp).toLocaleString(),
          tx.direction === 'in' ? t('wallet.tx.in') : t('wallet.tx.out'),
          `${tx.direction === 'in' ? '+' : '-'}${parseFloat(tx.amount).toFixed(7)}`,
          tx.counterparty, tx.memo ?? '', tx.txHash,
        ]),
        styles: { fontSize: 7 },
        headStyles: { fillColor: [99, 102, 241] },
      })

      doc.save(`transactions-${Date.now()}.pdf`)
      setOpen(false)
    } catch {
      setExportError(t('wallet.export.failed'))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((prev) => !prev)}
        disabled={transactions.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Download size={14} />
        {t('wallet.export.button')}
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <button type="button" className={styles.menuItem} role="menuitem" onClick={handleExportCsv}>
            <TableIcon size={14} />
            {t('wallet.export.csv')}
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={handleExportPdf}
            disabled={exporting}
          >
            <FileText size={14} />
            {exporting ? t('wallet.export.generating') : t('wallet.export.pdf')}
          </button>
          {exportError && <p className={styles.error} role="alert">{exportError}</p>}
        </div>
      )}
    </div>
  )
}