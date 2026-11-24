import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'
import { aggregateDailySpend, aggregateByCounterparty } from '../../hooks/useTransactionHistory'
import { formatDate } from '../../utils/format'
import { useTheme } from '../../hooks/useTheme'
import styles from './PaymentChart.module.css'

const SLICE_COLORS = [
  'var(--accent-secondary)',
  'var(--status-success)',
  'var(--status-warning)',
  'var(--accent-text-strong)',
  'var(--accent-info)',
  'var(--accent)',
  'var(--status-danger)',
  'var(--text-muted)',
]

interface PaymentChartProps {
  transactions: TransactionEvent[]
}

function truncateAddress(value: string): string {
  if (value === 'other' || value.length <= 12) return value
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

interface AgentSpendSlicePayload {
  counterparty: string
}

function formatXlm(value: number): string {
  return `${value.toFixed(7)} XLM`
}

export function PaymentChart({ transactions }: PaymentChartProps) {
  const { t, i18n } = useTranslation()
  const { effectiveTheme } = useTheme()
  const [legendOpen, setLegendOpen] = useState(true)
  const dailySummaryId = useId()
  const agentSummaryId = useId()

  const gridStroke = effectiveTheme === 'dark' ? 'var(--border-color)' : '#e6e9ee'
  const textColor = effectiveTheme === 'dark' ? '#f8fafc' : '#0A0E14'

  const dailySpend = useMemo(() => aggregateDailySpend(transactions, 30), [transactions])
  const byAgent = useMemo(() => aggregateByCounterparty(transactions), [transactions])

  const hasDailySpend = dailySpend.some((point) => point.total > 0)
  const hasBreakdown = byAgent.length > 0

  const dailyHeading = t('wallet.chart.dailySpendHeading')
  const agentHeading = t('wallet.chart.byAgentHeading')

  const dailySummary = useMemo(() => {
    const activeDays = dailySpend.filter((point) => point.total > 0)
    const total = activeDays.reduce((sum, point) => sum + point.total, 0)
    const points = activeDays
      .map((point) => `${formatDate(point.date, i18n.language)}: ${formatXlm(point.total)}`)
      .join('. ')
    return `${dailyHeading}. Total ${formatXlm(total)}. ${points}`
  }, [dailySpend, dailyHeading, i18n.language])

  const agentSummary = useMemo(() => {
    const total = byAgent.reduce((sum, point) => sum + point.total, 0)
    const points = byAgent
      .map((point) => `${truncateAddress(point.counterparty)}: ${formatXlm(point.total)}`)
      .join('. ')
    return `${agentHeading}. Total ${formatXlm(total)}. ${points}`
  }, [byAgent, agentHeading])

  const dailyAriaLabel = `${dailyHeading}. ${t('wallet.chart.spent')}: ${formatXlm(
    dailySpend.reduce((sum, point) => sum + point.total, 0),
  )}`
  const agentAriaLabel = `${agentHeading}. ${t('wallet.chart.spent')}: ${formatXlm(
    byAgent.reduce((sum, point) => sum + point.total, 0),
  )}`

  return (
    <div className={styles.container}>
      <div className={styles.chartCard}>
        <h3 className={styles.heading}>{dailyHeading}</h3>
        {hasDailySpend ? (
          <div
            role="img"
            aria-label={dailyAriaLabel}
            aria-describedby={dailySummaryId}
            data-testid="daily-spend-chart"
          >
            <p id={dailySummaryId} className="sr-only" data-testid="daily-spend-summary">
              {dailySummary}
            </p>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={dailySpend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridStroke} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value: string) => formatDate(value, i18n.language).slice(0, 5)}
                  tick={{ fontSize: 11, fill: textColor }}
                  interval={4}
                />
                <YAxis tick={{ fontSize: 11, fill: textColor }} width={40} />
                <Tooltip
                  formatter={(value: number) => [`${value.toFixed(7)} XLM`, t('wallet.chart.spent')]}
                  labelFormatter={(value: string) => formatDate(value, i18n.language)}
                  contentStyle={{
                    backgroundColor: effectiveTheme === 'dark' ? '#1A1F2E' : '#F8FAFC',
                    border: `1px solid ${effectiveTheme === 'dark' ? '#2A3040' : '#E6E9EE'}`,
                    borderRadius: '8px',
                    color: textColor,
                  }}
                />
                <Bar dataKey="total" fill="var(--accent-secondary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className={styles.empty}>{t('wallet.chart.noData')}</p>
        )}
      </div>

      <div className={styles.chartCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h3 className={styles.heading}>{agentHeading}</h3>
          <button
            onClick={() => setLegendOpen(!legendOpen)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '0.9rem',
              padding: '4px 8px',
            }}
          >
            {legendOpen ? '▼' : '▶'} Legend
          </button>
        </div>
        {hasBreakdown ? (
          <div
            role="img"
            aria-label={agentAriaLabel}
            aria-describedby={agentSummaryId}
            data-testid="agent-spend-chart"
          >
            <p id={agentSummaryId} className="sr-only" data-testid="agent-spend-summary">
              {agentSummary}
            </p>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={byAgent}
                  dataKey="total"
                  nameKey="counterparty"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  label={(entry: { counterparty?: string; percent?: number }) =>
                    `${truncateAddress(entry.counterparty ?? '')} (${((entry.percent ?? 0) * 100).toFixed(0)}%)`
                  }
                >
                  {byAgent.map((entry, index) => (
                    <Cell key={entry.counterparty} fill={SLICE_COLORS[index % SLICE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number, _name: string, item: { payload?: AgentSpendSlicePayload }) => [
                    `${value.toFixed(7)} XLM`,
                    truncateAddress(item?.payload?.counterparty ?? ''),
                  ]}
                />
                {legendOpen && (
                  <Legend formatter={(value: string) => truncateAddress(value)} wrapperStyle={{ fontSize: 11 }} />
                )}
              </PieChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className={styles.empty}>{t('wallet.chart.noData')}</p>
        )}
      </div>
    </div>
  )
}
