import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { TransactionTable } from './TransactionTable'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'

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
})