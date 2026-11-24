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

  it('exposes role="img", aria-label, and aria-describedby summaries for both charts', () => {
    const transactions = [
      txAt(0, '10', 'out', 'GAGENT111111111111111111'),
      txAt(1, '5', 'out', 'GAGENT222222222222222222'),
    ]
    render(<PaymentChart transactions={transactions} />)

    const dailyChart = screen.getByTestId('daily-spend-chart')
    expect(dailyChart).toHaveAttribute('role', 'img')
    expect(dailyChart).toHaveAttribute('aria-label')
    expect(dailyChart.getAttribute('aria-label')).toContain('Daily Spend')
    expect(dailyChart).toHaveAttribute('aria-describedby')

    const dailySummaryId = dailyChart.getAttribute('aria-describedby')!
    const dailySummary = document.getElementById(dailySummaryId)
    expect(dailySummary).toBeTruthy()
    expect(dailySummary).toHaveAttribute('data-testid', 'daily-spend-summary')
    expect(dailySummary?.textContent).toContain('10.0000000 XLM')
    expect(dailySummary?.textContent).toContain('5.0000000 XLM')

    const agentChart = screen.getByTestId('agent-spend-chart')
    expect(agentChart).toHaveAttribute('role', 'img')
    expect(agentChart).toHaveAttribute('aria-label')
    expect(agentChart.getAttribute('aria-label')).toContain('Cost Breakdown by Agent')
    expect(agentChart).toHaveAttribute('aria-describedby')

    const agentSummaryId = agentChart.getAttribute('aria-describedby')!
    const agentSummary = document.getElementById(agentSummaryId)
    expect(agentSummary).toBeTruthy()
    expect(agentSummary).toHaveAttribute('data-testid', 'agent-spend-summary')
    expect(agentSummary?.textContent).toMatch(/GAGE\.\.\.\d{4}/)
    expect(agentSummary?.textContent).toContain('10.0000000 XLM')
  })
})