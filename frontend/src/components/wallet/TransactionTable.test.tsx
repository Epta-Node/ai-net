import { render as rtlRender, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { TransactionTable } from './TransactionTable'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'

function render(ui: React.ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>)
}

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

  it('renders pending status badge with spinner and tooltip', () => {
    const transactions = [
      makeTx({ txHash: 'pending-tx-1', memo: 'escrow pending', status: 'pending' }),
    ]
    render(<TransactionTable transactions={transactions} loading={false} publicKey="GPUBKEY" />)
    const pendingBadge = screen.getByTestId('tx-status-pending')
    expect(pendingBadge).toBeInTheDocument()
    expect(pendingBadge).toHaveTextContent('Pending')
    expect(pendingBadge).toHaveAttribute('title', 'Transaction is pending confirmation on the Stellar network')
    expect(pendingBadge.querySelector('svg')).toBeInTheDocument()
  })

  it('renders completed status badge by default or when specified', () => {
    const transactions = [
      makeTx({ txHash: 'completed-tx-1', memo: 'standard tx', status: 'completed' }),
      makeTx({ txHash: 'completed-tx-2', memo: 'default status tx' }),
    ]
    render(<TransactionTable transactions={transactions} loading={false} publicKey="GPUBKEY" />)
    const badges = screen.getAllByTestId('tx-status-completed')
    expect(badges.length).toBe(2)
    expect(badges[0]).toHaveTextContent('Completed')
    expect(badges[0]).toHaveAttribute('title', 'Transaction completed')
  })

  it('renders failed status badge when transaction failed', () => {
    const transactions = [
      makeTx({ txHash: 'failed-tx-1', memo: 'failed tx', status: 'failed' }),
    ]
    render(<TransactionTable transactions={transactions} loading={false} publicKey="GPUBKEY" />)
    const failedBadge = screen.getByTestId('tx-status-failed')
    expect(failedBadge).toBeInTheDocument()
    expect(failedBadge).toHaveTextContent('Failed')
    expect(failedBadge).toHaveAttribute('title', 'Transaction failed')
  })
})