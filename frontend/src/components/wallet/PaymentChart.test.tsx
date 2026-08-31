import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { PaymentChart } from './PaymentChart'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'

const now = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000

function txAt(daysAgo: number, amount: string, direction: 'in' | 'out', counterparty: string): TransactionEvent {
  return {
    amount, direction, counterparty,
    timestamp: new Date(now - daysAgo * DAY_MS).toISOString(),
    txHash: `hash-${daysAgo}-${direction}-${counterparty}`,
  }
}

describe('PaymentChart', () => {
  it('shows the no-data state for both charts when there are no outgoing payments', () => {
    render(<PaymentChart transactions={[]} />)
    expect(screen.getAllByText('No spending data yet')).toHaveLength(2)
  })

  it('shows the no-data state when the wallet only has incoming payments', () => {
    render(<PaymentChart transactions={[txAt(1, '5', 'in', 'GCOUNTERPARTY1')]} />)
    expect(screen.getAllByText('No spending data yet')).toHaveLength(2)
  })

  it('renders both chart headings once there is outgoing spend', () => {
    const transactions = [
      txAt(0, '10', 'out', 'GAGENT111111111111111111'),
      txAt(1, '5', 'out', 'GAGENT222222222222222222'),
      txAt(2, '2', 'in', 'GAGENT111111111111111111'),
    ]
    render(<PaymentChart transactions={transactions} />)
    expect(screen.getByText('Daily Spend (Last 30 Days)')).toBeInTheDocument()
    expect(screen.getByText('Cost Breakdown by Agent')).toBeInTheDocument()
    expect(screen.queryByText('No spending data yet')).not.toBeInTheDocument()
  })

  it('ignores outgoing payments older than the 30-day window for the daily chart', () => {
    const transactions = [txAt(45, '10', 'out', 'GOLDAGENT00000000000000')]
    render(<PaymentChart transactions={transactions} />)
    expect(screen.getByText('No spending data yet')).toBeInTheDocument()
    expect(screen.getByText('Cost Breakdown by Agent')).toBeInTheDocument()
  })
})