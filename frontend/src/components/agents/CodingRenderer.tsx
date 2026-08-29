import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CodingResult } from '../../types/agent';
import { getCodeDetails } from '../../utils/agentUtils';

interface Props {
  result: CodingResult | null | undefined;
}

const CodingRenderer: React.FC<Props> = ({ result }) => {
  const { t } = useTranslation();
  const details = getCodeDetails(result);
  const [copied, setCopied] = useState(false);

  if (!details || !details.code) {
    return (
      <div
        className="empty-state"
        id="empty-coding"
        style={{
          padding: '24px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          background: 'var(--white-alpha-02)',
          borderRadius: '8px',
          border: '1px dashed var(--white-alpha-10)',
        }}
      >
        {t('agent.coding.empty')}
      </div>
    );
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(details.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy code to clipboard', err);
    }
  };

  return (
    <div
      className="coding-container"
      id="coding-output"
      style={{
        position: 'relative',
        borderRadius: '8px',
        overflow: 'hidden',
        border: '1px solid var(--white-alpha-10)',
        backgroundColor: 'var(--surface-black)',
      }}
    >
      <button
        onClick={handleCopy}
        className="copy-btn"
        id="btn-copy-code"
        style={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          zIndex: 10,
          background: copied ? 'var(--success)' : 'var(--white-alpha-08)',
          border: '1px solid var(--white-alpha-15)',
          color: 'var(--text-inverse)',
          padding: '6px 12px',
          borderRadius: '6px',
          cursor: 'pointer',
          fontSize: '0.8rem',
          fontWeight: 600,
          transition: 'all 0.2s ease',
          outline: 'none',
        }}
      >
        {copied ? t('agent.coding.copied') : t('agent.coding.copyCode')}
      </button>
      <SyntaxHighlighter
        language={details.language}
        style={vscDarkPlus}
        customStyle={{
          margin: 0,
          padding: '20px',
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
