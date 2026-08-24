import React, { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Capability, AgentResult, ResearchReportResult, CodingResult, RiskResult, DesignResult } from '../../types/agent';
import RiskMatrix from './RiskMatrix';
import DesignRenderer from './DesignRenderer';

// Lazy loaded components for bundle optimization
const ResearchReportRenderer = React.lazy(() => import('./ResearchReportRenderer'));
const CodingRenderer = React.lazy(() => import('./CodingRenderer'));

interface Props {
  agentType: Capability;
  result: AgentResult;
}

const LoadingFallback: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div
      style={{
        padding: '24px',
        color: 'var(--text-secondary)',
        fontStyle: 'italic',
        fontSize: '0.9rem',
      }}
    >
      {t('agent.output.loadingRenderer')}
    </div>
  );
};

const AgentOutputRenderer: React.FC<Props> = ({ agentType, result }) => {
  const { t } = useTranslation();
  // All renderers handle null/undefined result with an empty-state placeholder
  if (result === null || result === undefined) {
    return (
      <div
        className="empty-state"
        id={`empty-${agentType}`}
        style={{
          padding: '24px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          background: 'rgba(255, 255, 255, 0.02)',
          borderRadius: '8px',
          border: '1px dashed rgba(255, 255, 255, 0.1)',
        }}
      >
        {t('agent.output.empty')}
      </div>
    );
  }

  switch (agentType) {
    case 'research':
    case 'report':
      return (
        <Suspense fallback={<LoadingFallback />}>
          <ResearchReportRenderer result={result as ResearchReportResult} />
        </Suspense>
      );
    case 'coding':
      return (
        <Suspense fallback={<LoadingFallback />}>
          <CodingRenderer result={result as CodingResult} />
        </Suspense>
      );
    case 'risk':
      return <RiskMatrix result={result as RiskResult} />;
    case 'design':
      return <DesignRenderer result={result as DesignResult} />;
    default:
      return (
        <div style={{ color: 'var(--danger)', padding: '12px' }}>
          Unknown agent type: {agentType}
        </div>
      );
  }
};

export default AgentOutputRenderer;
