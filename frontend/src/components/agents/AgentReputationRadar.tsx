import React from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip } from 'recharts';
import type { ReputationDimensions } from '../../types/agent';
import styles from './AgentReputationRadar.module.css';
import { AccessibleChart } from '../common/AccessibleChart';

interface AgentReputationRadarProps {
  dimensions: ReputationDimensions;
}

export const AgentReputationRadar: React.FC<AgentReputationRadarProps> = ({ dimensions }) => {
  const data = [
    { subject: 'Quality', A: dimensions.quality, fullMark: 100 },
    { subject: 'Speed', A: dimensions.speed, fullMark: 100 },
    { subject: 'Reliability', A: dimensions.reliability, fullMark: 100 },
    { subject: 'Cost', A: dimensions.cost, fullMark: 100 },
  ];

  return (
    <div className={styles.container}>
      <AccessibleChart
        label="Agent reputation dimensions"
        points={data.map((point) => ({ label: point.subject, value: `${point.A} / ${point.fullMark}` }))}
      >
        <ResponsiveContainer width="100%" height={250}>
          <RadarChart cx="50%" cy="50%" outerRadius="80%" data={data}>
            <PolarGrid />
            <PolarAngleAxis dataKey="subject" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} />
            <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} />
            <Radar name="Reputation" dataKey="A" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.6} />
            <Tooltip />
          </RadarChart>
        </ResponsiveContainer>
      </AccessibleChart>
    </div>
  );
};
