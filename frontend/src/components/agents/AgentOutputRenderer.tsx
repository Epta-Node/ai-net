import React, { Suspense, useState } from 'react';
import {
  Capability,
  AgentResult,
  ResearchReportResult,
  CodingResult,
  RiskResult,
  DesignResult
} from '../../types/agent';
import RiskMatrix from './RiskMatrix';
import DesignRenderer from './DesignRenderer';
import { Maximize2, Minimize2, Search, Clock, Cpu, Sparkles, X } from 'lucide-react';

const ResearchReportRenderer = React.lazy(() => import('./ResearchReportRenderer'));
const CodingRenderer = React.lazy(() => import('./CodingRenderer'));

interface Props {
  agentType: Capability;
  result: AgentResult;
  agentName?: string;
  executionTimeMs?: number;
  tokenCount?: number;
}

const LoadingFallback: React.FC = () => (
  <div
    style={{
      padding: '24px',
      color: 'var(--text-secondary)',
      fontStyle: 'italic',
      fontSize: '0.9rem',
    }}
  >
    Loading renderer...
  </div>
);

const getAgentDisplayName = (type: Capability, customName?: string): string => {
  if (customName) return customName;
  switch (type) {
    case 'research':
    case 'report':
      return 'Research Agent';
    case 'coding':
      return 'Coding Agent';
    case 'design':
      return 'Design Agent';
    case 'risk':
      return 'Risk Matrix Agent';
    default:
      return `${type} Agent`;
  }
};

const AgentOutputRenderer: React.FC<Props> = ({
  agentType,
  result,
  agentName,
  executionTimeMs,
  tokenCount,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isFullScreen, setIsFullScreen] = useState<boolean>(false);

  const displayName = getAgentDisplayName(agentType, agentName);

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
        No output generated yet.
      </div>
    );
  }

  const renderContent = () => {
    switch (agentType) {
      case 'research':
      case 'report':
        return (
          <Suspense fallback={<LoadingFallback />}>
            <ResearchReportRenderer
              result={result as ResearchReportResult}
              searchQuery={searchQuery}
            />
          </Suspense>
        );
      case 'coding':
        return (
          <Suspense fallback={<LoadingFallback />}>
            <CodingRenderer
              result={result as CodingResult}
              searchQuery={searchQuery}
            />
          </Suspense>
        );
      case 'risk':
        return <RiskMatrix result={result as RiskResult} />;
      case 'design':
        return (
          <DesignRenderer
            result={result as DesignResult}
            searchQuery={searchQuery}
          />
        );
      default:
        return (
          <div style={{ color: 'var(--danger)', padding: '12px' }}>
            Unknown agent type: {agentType}
          </div>
        );
    }
  };

  const formattedTime =
    executionTimeMs !== undefined
      ? executionTimeMs >= 1000
        ? `${(executionTimeMs / 1000).toFixed(2)}s`
        : `${executionTimeMs}ms`
      : null;

  const headerContainerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '12px',
    padding: '12px 16px',
    backgroundColor: 'rgba(17, 21, 29, 0.7)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '10px',
    marginBottom: '16px',
    backdropFilter: 'blur(8px)',
  };

  const fullScreenOverlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 9990,
    background: 'rgba(10, 14, 20, 0.94)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    display: 'flex',
    flexDirection: 'column',
    padding: '24px',
    overflow: 'hidden',
  };

  const headerControls = (
    <div className="agent-output-header" data-testid="agent-output-header" style={headerContainerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Sparkles size={16} color="var(--accent-cyan, #38bdf8)" />
          <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#f5f7fa' }} data-testid="agent-name">
            {displayName}
          </span>
        </div>

        {formattedTime && (
          <span
            data-testid="execution-time"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '0.75rem',
              color: 'var(--text-secondary, #8a93a3)',
              background: 'rgba(255, 255, 255, 0.05)',
              padding: '3px 8px',
              borderRadius: '6px',
              fontFamily: 'monospace',
            }}
          >
            <Clock size={12} />
            <span>{formattedTime}</span>
          </span>
        )}

        {tokenCount !== undefined && (
          <span
            data-testid="token-count"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '0.75rem',
              color: 'var(--accent-purple, #8b5cf6)',
              background: 'rgba(139, 92, 246, 0.12)',
              border: '1px solid rgba(139, 92, 246, 0.25)',
              padding: '3px 8px',
              borderRadius: '6px',
              fontFamily: 'monospace',
              fontWeight: 600,
            }}
          >
            <Cpu size={12} />
            <span>{tokenCount.toLocaleString()} tokens</span>
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search
            size={14}
            color="#8a93a3"
            style={{ position: 'absolute', left: '10px', pointerEvents: 'none' }}
          />
          <input
            type="text"
            placeholder="Search output..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="output-search-input"
            style={{
              padding: '5px 10px 5px 30px',
              fontSize: '0.8rem',
              borderRadius: '6px',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              background: 'rgba(0, 0, 0, 0.3)',
              color: '#fff',
              outline: 'none',
              width: '160px',
            }}
          />
        </div>

        <button
          type="button"
          onClick={() => setIsFullScreen((prev) => !prev)}
          data-testid="fullscreen-toggle-btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            background: isFullScreen ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255, 255, 255, 0.08)',
            border: isFullScreen ? '1px solid #38bdf8' : '1px solid rgba(255, 255, 255, 0.12)',
            color: '#fff',
            padding: '5px 10px',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '0.8rem',
            fontWeight: 600,
            transition: 'all 0.2s ease',
          }}
          title={isFullScreen ? 'Exit Fullscreen' : 'Full-screen Review'}
        >
          {isFullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          <span>{isFullScreen ? 'Exit' : 'Full Screen'}</span>
        </button>
      </div>
    </div>
  );

  if (isFullScreen) {
    return (
      <div
        className="fullscreen-output-overlay"
        data-testid="fullscreen-output-overlay"
        style={fullScreenOverlayStyle}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          {headerControls}
          <button
            type="button"
            onClick={() => setIsFullScreen(false)}
            data-testid="fullscreen-close-btn"
            style={{
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#f87171',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <X size={16} />
            <span>Close</span>
          </button>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '24px',
            background: 'rgba(17, 21, 29, 0.8)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '12px',
          }}
        >
          {renderContent()}
        </div>
      </div>
    );
  }

  return (
    <div className="agent-output-renderer-wrapper" data-testid="agent-output-wrapper">
      {headerControls}
      <div className="agent-output-body">{renderContent()}</div>
    </div>
  );
};

export default AgentOutputRenderer;
