import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import type { TransactionEvent } from '../../hooks/useTransactionHistory'
import { aggregateDailySpend, aggregateByCounterparty } from '../../hooks/useTransactionHistory'
import { formatDate } from '../../utils/format'
import styles from './PaymentChart.module.css'
import { AccessibleChart } from '../common/AccessibleChart'

const SLICE_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#ef4444', '#64748b']

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

export function PaymentChart({ transactions }: PaymentChartProps) {
  const { t, i18n } = useTranslation()

  const dailySpend = useMemo(() => aggregateDailySpend(transactions, 30), [transactions])
  const byAgent = useMemo(() => aggregateByCounterparty(transactions), [transactions])

  const hasDailySpend = dailySpend.some((point) => point.total > 0)
  const hasBreakdown = byAgent.length > 0

  return (
    <div className={styles.container}>
      <div className={styles.chartCard}>
        <h3 className={styles.heading}>{t('wallet.chart.dailySpendHeading')}</h3>
        {hasDailySpend ? (
          <AccessibleChart
            label={t('wallet.chart.dailySpendHeading')}
            points={dailySpend.map((point) => ({
              label: formatDate(point.date, i18n.language),
              value: `${point.total.toFixed(7)} XLM`,
              detail: t('wallet.chart.spent'),
            }))}
          >
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={dailySpend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-color)" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value: string) => formatDate(value, i18n.language).slice(0, 5)}
                  tick={{ fontSize: 11 }}
                  interval={4}
                />
                <YAxis tick={{ fontSize: 11 }} width={40} />
                <Tooltip
                  formatter={(value: number) => [`${value.toFixed(7)} XLM`, t('wallet.chart.spent')]}
                  labelFormatter={(value: string) => formatDate(value, i18n.language)}
                />
                <Bar dataKey="total" fill="var(--primary)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </AccessibleChart>
        ) : (
          <p className={styles.empty}>{t('wallet.chart.noData')}</p>
        )}
      </div>

      <div className={styles.chartCard}>
        <h3 className={styles.heading}>{t('wallet.chart.byAgentHeading')}</h3>
        {hasBreakdown ? (
          <AccessibleChart
            label={t('wallet.chart.byAgentHeading')}
            points={byAgent.map((point) => ({
              label: truncateAddress(point.counterparty),
              value: `${point.total.toFixed(7)} XLM`,
            }))}
          >
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
                <Legend formatter={(value: string) => truncateAddress(value)} wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </AccessibleChart>
        ) : (
          <p className={styles.empty}>{t('wallet.chart.noData')}</p>
        )}
      </div>
    </div>
  )
}
