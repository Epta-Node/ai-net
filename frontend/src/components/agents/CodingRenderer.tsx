import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CodingResult } from '../../types/agent';
import { getCodeDetails } from '../../utils/agentUtils';
import CopyButton from '../common/CopyButton';

interface Props {
  result: CodingResult | null | undefined;
  searchQuery?: string;
}

const CodingRenderer: React.FC<Props> = ({ result, searchQuery }) => {
  const details = getCodeDetails(result);

  if (!details || !details.code) {
    return (
      <div
        className="empty-state"
        id="empty-coding"
        style={{
          padding: '24px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          background: 'rgba(255, 255, 255, 0.02)',
          borderRadius: '8px',
          border: '1px dashed rgba(255, 255, 255, 0.1)',
        }}
      >
        No code output available.
      </div>
    );
  }

  const matchesSearch =
    !searchQuery || details.code.toLowerCase().includes(searchQuery.toLowerCase());

  if (!matchesSearch) {
    return (
      <div
        style={{
          padding: '20px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          fontSize: '0.85rem',
          fontStyle: 'italic',
        }}
      >
        No code matching search filter "{searchQuery}".
      </div>
    );
  }

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    borderRadius: '8px',
    overflow: 'hidden',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    backgroundColor: '#1e1e1e',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 16px',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
  };

  return (
    <div
      className="coding-container"
      id="coding-output"
      data-testid="coding-output"
      style={containerStyle}
    >
      <div style={headerStyle}>
        <span style={{ fontSize: '0.8rem', color: '#94a3b8', fontFamily: 'monospace', fontWeight: 600 }}>
          {details.language || 'code'}
        </span>
        <CopyButton text={details.code} label="Copy Code" />
      </div>

      <SyntaxHighlighter
        language={details.language}
        style={vscDarkPlus}
        showLineNumbers
        customStyle={{
          margin: 0,
          padding: '16px 20px',
          fontSize: '0.9rem',
          backgroundColor: 'transparent',
        }}
      >
        {details.code}
      </SyntaxHighlighter>
    </div>
  );
};

export default CodingRenderer;
