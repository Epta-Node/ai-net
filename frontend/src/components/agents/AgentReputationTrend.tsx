/**
 * AgentReputationTrend
 *
 * Renders a line chart of an agent's reputation score history.
 * Fixed by Issue #629 to:
 *  - wrap the Recharts chart in <AccessibleChart> so keyboard and screen-reader
 *    users can navigate individual data points (previously imported but unused)
 *  - remove the dangling import that made AccessibleChart a dead symbol
 */
import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Brush } from 'recharts';
import type { ReputationHistory } from '../../types/agent';
import { AccessibleChart } from '../common/AccessibleChart';
import type { AccessibleChartPoint } from '../common/AccessibleChart';
import styles from './AgentReputationTrend.module.css';

interface AgentReputationTrendProps {
  history: ReputationHistory[];
}

export const AgentReputationTrend: React.FC<AgentReputationTrendProps> = ({ history }) => {
  // Format dates and prepare chart data
  const data = history.map(item => {
    const d = new Date(item.date);
    return {
      ...item,
      displayDate: `${d.getMonth() + 1}/${d.getDate()}`,
    };
  });

  // Build the accessible data points for keyboard/screen-reader navigation
  const points: AccessibleChartPoint[] = data.map(item => ({
    label: item.displayDate,
    value: String(item.score),
    detail: `Score on ${item.displayDate}: ${item.score}`,
  }));

  return (
    <div className={styles.container}>
      <AccessibleChart label="Agent reputation score over time" points={points}>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="displayDate" />
            <YAxis domain={[0, 100]} />
            <Tooltip />
            <Line
              type="monotone"
              dataKey="score"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
            <Brush dataKey="displayDate" height={30} stroke="var(--accent)" />
          </LineChart>
        </ResponsiveContainer>
      </AccessibleChart>
    </div>
  );
};
