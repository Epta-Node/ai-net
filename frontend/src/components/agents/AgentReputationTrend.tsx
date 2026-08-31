import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Brush } from 'recharts';
import type { ReputationHistory } from '../../types/agent';
import styles from './AgentReputationTrend.module.css';

interface AgentReputationTrendProps {
  history: ReputationHistory[];
}

export const AgentReputationTrend: React.FC<AgentReputationTrendProps> = ({ history }) => {
  // Format dates for display
  const data = history.map(item => {
    const d = new Date(item.date);
    return {
      ...item,
      displayDate: `${d.getMonth() + 1}/${d.getDate()}`
    };
  });

  return (
    <div className={styles.container}>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="displayDate" />
          <YAxis domain={[0, 100]} />
          <Tooltip />
          <Line type="monotone" dataKey="score" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
          <Brush dataKey="displayDate" height={30} stroke="var(--accent)" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};
