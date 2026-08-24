import React from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ResearchReportResult } from '../../types/agent';
import { getMarkdown } from '../../utils/agentUtils';

interface Props {
  result: ResearchReportResult | null | undefined;
}

const ResearchReportRenderer: React.FC<Props> = ({ result }) => {
  const { t } = useTranslation();
  const markdown = getMarkdown(result);

  if (!markdown) {
    return (
      <div
        className="empty-state"
        id="empty-research"
        style={{
          padding: '24px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          background: 'rgba(255, 255, 255, 0.02)',
          borderRadius: '8px',
          border: '1px dashed rgba(255, 255, 255, 0.1)',
        }}
      >
        {t('agent.research.empty')}
      </div>
    );
  }

  return (
    <div
      className="markdown-body"
      id="research-markdown"
      style={{
        color: '#f8fafc',
        lineHeight: '1.7',
        fontSize: '1rem',
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
};

export default ResearchReportRenderer;
