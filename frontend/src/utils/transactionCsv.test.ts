import { describe, it, expect, vi } from 'vitest'
import {
  transactionsToCSV,
  escapeCsvCell,
  type Transaction,
} from './transactionCsv'

describe('transactionsToCSV', () => {
  it('handles an empty array by returning only the CSV header row', () => {
    const csv = transactionsToCSV([])
    expect(csv).toBe(
      '"date","type","from_wallet","to_wallet","amount_xlm","task_id","status","stellar_tx_hash"'
    )
  })

  it('filters by date range correctly', () => {
    const txs: Transaction[] = [
      {
        date: new Date('2026-01-01T00:00:00Z'),
        amount_xlm: '10',
        type: 'payment',
      },
      {
        date: new Date('2026-02-15T00:00:00Z'),
        amount_xlm: '20',
        type: 'payment',
      },
      {
        date: new Date('2026-03-30T00:00:00Z'),
        amount_xlm: '30',
        type: 'payment',
      },
    ]

    const csv = transactionsToCSV(txs, {
      dateRange: {
        from: new Date('2026-02-01T00:00:00Z'),
        to: new Date('2026-02-28T23:59:59Z'),
      },
    })

    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(2) // header + 1 row
    expect(lines[1]).toContain('2026-02-15')
    expect(lines[1]).toContain('"20"')
  })

  it('filters by transaction types', () => {
    const txs: Transaction[] = [
      { type: 'payment', amount_xlm: '10' },
      { type: 'escrow_lock', amount_xlm: '50' },
      { type: 'escrow_release', amount_xlm: '50' },
    ]

    const csv = transactionsToCSV(txs, { types: ['escrow_lock'] })
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"escrow_lock"')
    expect(lines[1]).not.toContain('"payment"')
  })

  it('safely escapes special characters and formula injection attempts (XSS safe)', () => {
    const dangerousTx: Transaction = {
      memo: '=CMD("calc.exe")',
      counterparty: '+1234567890',
      task_id: '@SUM(A1:A10)',
      amount_xlm: '-999',
      status: 'Normal "Quoted" Status',
    }

    const csv = transactionsToCSV([dangerousTx])
    const row = csv.split('\r\n')[1]

    // Prepended single quote to neutralize formula injection
    expect(row).toContain('\'=CMD("calc.exe")')
    expect(row).toContain('\'+1234567890')
    expect(row).toContain('\'@SUM(A1:A10)')
    expect(row).toContain('\'-999')
    // Double quotes escaped as ""
    expect(row).toContain('Normal ""Quoted"" Status')
  })

  it('warns and truncates when row count exceeds maxRows', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const txs: Transaction[] = Array.from({ length: 15 }, (_, i) => ({
      amount_xlm: i,
      type: 'payment',
    }))

    const csv = transactionsToCSV(txs, { maxRows: 10 })
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(11) // header + 10 rows
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('truncated'))
    warnSpy.mockRestore()
  })
})
