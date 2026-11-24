import React, { useState, useRef, useEffect } from 'react'
import { Download, ChevronDown, AlertTriangle, Loader2 } from 'lucide-react'
import { downloadTextFile } from '../../utils/download'
import { buildCsvInChunks, transactionsToCSV, type Transaction } from '../../utils/transactionCsv'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'

export type ExportPreset = 'all' | '7d' | '30d' | '90d' | 'custom'

interface ExportButtonProps {
  transactions: (Transaction | TransactionEvent)[]
  className?: string
}

export const ExportButton: React.FC<ExportButtonProps> = ({
  transactions,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [pendingExportTxs, setPendingExportTxs] = useState<(Transaction | TransactionEvent)[]>([])
  const [customRange, setCustomRange] = useState({ from: '', to: '' })
  const [showCustomRangePicker, setShowCustomRangePicker] = useState(false)

  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const filterByPreset = (preset: ExportPreset, fromDate?: Date, toDate?: Date) => {
    const now = new Date()
    let from: Date | undefined
    const to: Date = toDate ?? now

    if (preset === '7d') {
      from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    } else if (preset === '30d') {
      from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    } else if (preset === '90d') {
      from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    } else if (preset === 'custom') {
      from = fromDate
    }

    if (!from && !toDate) return transactions

    return transactions.filter((tx) => {
      const rawDate = 'date' in tx && tx.date ? tx.date : ('timestamp' in tx ? tx.timestamp : undefined)
      if (!rawDate) return true
      const d = new Date(rawDate)
      if (isNaN(d.getTime())) return true
      if (from && d < from) return false
      if (toDate && d > toDate) return false
      return true
    })
  }

  const triggerExport = async (filteredTxs: (Transaction | TransactionEvent)[]) => {
    // If over 10,000 rows, show confirmation dialog first
    if (filteredTxs.length > 10_000) {
      setPendingExportTxs(filteredTxs)
      setShowConfirmModal(true)
      return
    }

    await performExport(filteredTxs)
  }

  const performExport = async (filteredTxs: (Transaction | TransactionEvent)[]) => {
    setIsExporting(true)
    setProgress(0)

    try {
      let csvContent = ''
      if (filteredTxs.length > 1000) {
        csvContent = await buildCsvInChunks(filteredTxs, {}, (p) => setProgress(p))
      } else {
        csvContent = transactionsToCSV(filteredTxs)
        setProgress(100)
      }

      const timestamp = new Date().toISOString().slice(0, 10)
      downloadTextFile(csvContent, `transactions-${timestamp}.csv`, 'text/csv;charset=utf-8')
    } finally {
      setIsExporting(false)
      setShowConfirmModal(false)
      setPendingExportTxs([])
    }
  }

  const handleSelectPreset = (preset: ExportPreset) => {
    setIsOpen(false)
    if (preset === 'custom') {
      setShowCustomRangePicker(true)
      return
    }
    const filtered = filterByPreset(preset)
    void triggerExport(filtered)
  }

  const handleCustomExportSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setShowCustomRangePicker(false)
    const fromDate = customRange.from ? new Date(customRange.from) : undefined
    const toDate = customRange.to ? new Date(customRange.to) : undefined
    const filtered = filterByPreset('custom', fromDate, toDate)
    void triggerExport(filtered)
  }

  return (
    <div className={`relative inline-block ${className}`} ref={dropdownRef}>
      <button
        type="button"
        id="btn-export-csv"
        data-testid="export-csv-btn"
        disabled={isExporting || transactions.length === 0}
        onClick={() => setIsOpen((prev) => !prev)}
        className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle,#333)] bg-[var(--surface-sunken,#1e1e1e)] px-3.5 py-2 text-sm font-medium text-[var(--text-primary,#fff)] transition-colors hover:border-[var(--primary,#9333ea)] hover:bg-[var(--surface-sunken-hover,#262626)] disabled:cursor-not-allowed disabled:opacity-50"
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label="Export transactions to CSV"
      >
        {isExporting ? (
          <>
            <Loader2 size={16} className="animate-spin text-[var(--primary,#9333ea)]" />
            <span>Exporting ({progress}%)…</span>
          </>
        ) : (
          <>
            <Download size={16} aria-hidden="true" />
            <span>Export CSV</span>
            <ChevronDown size={14} aria-hidden="true" />
          </>
        )}
      </button>

      {/* Preset options menu */}
      {isOpen && (
        <div
          role="menu"
          aria-orientation="vertical"
          className="absolute right-0 z-50 mt-2 w-48 rounded-xl border border-[var(--border-subtle,#333)] bg-[var(--surface-sunken,#1a1a1a)] p-1 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleSelectPreset('7d')}
            className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary,#fff)] hover:bg-[var(--surface-sunken-hover,#2a2a2a)]"
          >
            Last 7 days
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleSelectPreset('30d')}
            className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary,#fff)] hover:bg-[var(--surface-sunken-hover,#2a2a2a)]"
          >
            Last 30 days
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleSelectPreset('90d')}
            className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary,#fff)] hover:bg-[var(--surface-sunken-hover,#2a2a2a)]"
          >
            Last 90 days
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleSelectPreset('all')}
            className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary,#fff)] hover:bg-[var(--surface-sunken-hover,#2a2a2a)]"
          >
            All time
          </button>
          <div className="my-1 border-t border-[var(--border-subtle,#2a2a2a)]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => handleSelectPreset('custom')}
            className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary,#fff)] hover:bg-[var(--surface-sunken-hover,#2a2a2a)]"
          >
            Custom range…
          </button>
        </div>
      )}

      {/* Custom Range Dialog */}
      {showCustomRangePicker && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="custom-range-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-sm rounded-2xl border border-[var(--border-subtle,#333)] bg-[var(--surface-sunken,#181818)] p-6 shadow-2xl">
            <h3 id="custom-range-title" className="text-lg font-semibold text-white">
              Export custom date range
            </h3>
            <form onSubmit={handleCustomExportSubmit} className="mt-4 space-y-4">
              <div>
                <label htmlFor="custom-from" className="block text-xs font-medium text-gray-300">
                  From
                </label>
                <input
                  type="date"
                  id="custom-from"
                  value={customRange.from}
                  onChange={(e) => setCustomRange((prev) => ({ ...prev, from: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-700 bg-black/40 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label htmlFor="custom-to" className="block text-xs font-medium text-gray-300">
                  To
                </label>
                <input
                  type="date"
                  id="custom-to"
                  value={customRange.to}
                  onChange={(e) => setCustomRange((prev) => ({ ...prev, to: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-700 bg-black/40 px-3 py-2 text-sm text-white"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCustomRangePicker(false)}
                  className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-[var(--primary,#9333ea)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  Export
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Dialog for > 10,000 rows */}
      {showConfirmModal && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="large-export-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-yellow-600/40 bg-[var(--surface-sunken,#181818)] p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-yellow-500">
              <AlertTriangle size={24} />
              <h3 id="large-export-title" className="text-lg font-semibold text-white">
                Large Dataset Export Warning
              </h3>
            </div>
            <p className="mt-3 text-sm text-gray-300">
              The requested export contains{' '}
              <strong className="text-white">{pendingExportTxs.length.toLocaleString()} rows</strong>.
              Exporting very large datasets may take a few moments and could impact performance.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowConfirmModal(false)
                  setPendingExportTxs([])
                }}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => performExport(pendingExportTxs)}
                className="rounded-lg bg-yellow-600 px-4 py-2 text-sm font-medium text-white hover:bg-yellow-700"
              >
                Confirm &amp; Export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ExportButton