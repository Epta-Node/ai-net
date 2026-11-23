import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TransactionTable } from './TransactionTable'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'
import { transactionsToCSV } from '../../utils/transactionCsv'

// Mock toast hook
const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({ showToast }),
}))

// Mock downloadTextFile so tests don't trigger real file downloads
const { downloadTextFile } = vi.hoisted(() => ({ downloadTextFile: vi.fn() }))
vi.mock('../../utils/download', () => ({ downloadTextFile }))

// Mock navigator.clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockImplementation(() => Promise.resolve()),
  },
})

function makeTx(overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return {
    amount: '10',
    direction: 'out',
    counterparty: 'GABC1234567890XYZ1234567890',
    memo: 'test memo',
    timestamp: new Date().toISOString(),
    txHash: 'hash1',
    ...overrides,
  }
}

describe('TransactionTable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prompts to connect when no wallet is connected', () => {
    render(<TransactionTable transactions={[]} loading={false} publicKey={null} />)
    expect(screen.getByText('Connect your wallet to view transaction history.')).toBeInTheDocument()
  })

  it('shows the empty state when the wallet has no transactions', () => {
    render(<TransactionTable transactions={[]} loading={false} publicKey="GPUBKEY" />)
    expect(screen.getByText('No transactions yet')).toBeInTheDocument()
  })

  it('filters rows by search term across memo text', () => {
    const transactions = [
      makeTx({ txHash: 'abc111', memo: 'research task payment' }),
      makeTx({ txHash: 'def222', memo: 'coding task payment' }),
    ]
    render(<TransactionTable transactions={transactions} loading={false} publicKey="GPUBKEY" />)
    expect(screen.getByText('research task payment')).toBeInTheDocument()
    expect(screen.getByText('coding task payment')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search by tx hash, agent, or memo'), {
      target: { value: 'coding' },
    })
    expect(screen.queryByText('research task payment')).not.toBeInTheDocument()
    expect(screen.getByText('coding task payment')).toBeInTheDocument()
  })

  it('shows a no-matches state when the search excludes every transaction', () => {
    const transactions = [makeTx({ memo: 'research task' })]
    render(<TransactionTable transactions={transactions} loading={false} publicKey="GPUBKEY" />)
    fireEvent.change(screen.getByPlaceholderText('Search by tx hash, agent, or memo'), {
      target: { value: 'nothing-matches-this' },
    })
    expect(screen.getByText('No transactions match your filters')).toBeInTheDocument()
  })

  it('paginates according to the selected page size and steps with Next/Previous', () => {
    const transactions = Array.from({ length: 30 }, (_, i) =>
      makeTx({ txHash: `hash-${i}`, memo: `memo-${i}`, timestamp: new Date(Date.now() - i * 1000).toISOString() })
    )
    render(<TransactionTable transactions={transactions} loading={false} publicKey="GPUBKEY" />)
    expect(screen.getByText('memo-0')).toBeInTheDocument()
    expect(screen.queryByText('memo-26')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('memo-26')).toBeInTheDocument()
    expect(screen.queryByText('memo-0')).not.toBeInTheDocument()
  })

  it('displays a running total reflecting the currently filtered transactions', () => {
    const transactions = [
      makeTx({ txHash: 'in-1', direction: 'in', amount: '10', memo: 'incoming' }),
      makeTx({ txHash: 'out-1', direction: 'out', amount: '4', memo: 'outgoing' }),
    ]
    render(<TransactionTable transactions={transactions} loading={false} publicKey="GPUBKEY" />)
    expect(screen.getByText('+6.0000000 XLM')).toBeInTheDocument()
  })

  it('copies the counterparty address to clipboard and shows a toast', async () => {
    const counterparty = 'GCOUNTERPARTY1234567890ABCDEFGHIJ'
    const transactions = [makeTx({ txHash: 'tx1', counterparty })]
    render(<TransactionTable transactions={transactions} loading={false} publicKey="GPUBKEY" />)

    const copyButtons = screen.getAllByTestId('copy-button')
    expect(copyButtons).toHaveLength(1)

    fireEvent.click(copyButtons[0])

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(counterparty)
      expect(showToast).toHaveBeenCalledWith('Address copied to clipboard', 'success')
    })
  })

  it('exports transactions as CSV with correct content when Export CSV → All time is clicked', async () => {
    const transactions = [
      makeTx({
        txHash: 'txhash-aaa',
        direction: 'in',
        amount: '25.5',
        counterparty: 'GSENDER1234567890ABCDEFGHIJKLMN',
        memo: 'payment for research',
        timestamp: '2026-06-01T12:00:00.000Z',
      }),
      makeTx({
        txHash: 'txhash-bbb',
        direction: 'out',
        amount: '10',
        counterparty: 'GRECEIVER9876543210ABCDEFGHIJK',
        memo: 'coding task',
        timestamp: '2026-06-02T08:00:00.000Z',
      }),
    ]

    render(<TransactionTable transactions={transactions} loading={false} publicKey="GPUBKEY" />)

    // Click the main Export CSV button to open the preset menu
    fireEvent.click(screen.getByTestId('export-csv-btn'))

    // Click "All time" to export all transactions
    fireEvent.click(screen.getByRole('menuitem', { name: 'All time' }))

    // The download utility should be called with valid CSV content
    await waitFor(() => {
      expect(downloadTextFile).toHaveBeenCalledOnce()
    })

    const [csvContent, filename, mimeType] = downloadTextFile.mock.calls[0] as [string, string, string]

    // Verify file metadata
    expect(filename).toMatch(/^transactions-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(mimeType).toBe('text/csv;charset=utf-8')

    // Verify the CSV structure matches transactionsToCSV output
    const expected = transactionsToCSV(transactions)
    expect(csvContent).toBe(expected)

    // Verify the header row is present
    const lines = csvContent.split('\r\n')
    expect(lines[0]).toBe('date,type,from_wallet,to_wallet,amount_xlm,task_id,status,stellar_tx_hash')

    // Verify both transaction rows exist in the CSV
    expect(lines).toHaveLength(3) // header + 2 rows
    expect(lines[1]).toContain('2026-06-01')
    expect(lines[1]).toContain('"25.5"')
    expect(lines[1]).toContain('"payment for research"')
    expect(lines[2]).toContain('2026-06-02')
    expect(lines[2]).toContain('"10"')
    expect(lines[2]).toContain('"coding task"')
  })
})