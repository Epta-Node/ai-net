import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Check, Copy, Download } from 'lucide-react';
import { CodingResult } from '../../types/agent';
import { getCodeDetails } from '../../utils/agentUtils';
import { copyToClipboard, downloadTextFile } from '../../utils/download';

interface Props {
  result: CodingResult | null | undefined;
  searchQuery?: string;
}

const buttonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  padding: '5px 10px',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: 'var(--text-secondary, #cbd5e1)',
  background: 'rgba(255, 255, 255, 0.05)',
  border: '1px solid var(--white-alpha-10, rgba(255, 255, 255, 0.12))',
  borderRadius: '6px',
  cursor: 'pointer',
  transition: 'all 0.2s ease',
};

const buttonHoverStyle: React.CSSProperties = { ...buttonStyle, background: 'rgba(255,255,255,0.1)' };

const CodingRenderer: React.FC<Props> = ({ result, searchQuery }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const details = getCodeDetails(result);

  const handleCopy = useCallback(async () => {
    if (!details?.code) return;
    const ok = await copyToClipboard(details.code);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [details?.code]);

  // Extension follows the detected language so the saved file opens in the
  // right tool (a .ts download should not be a bare .txt).
  const handleDownload = useCallback(() => {
    if (!details?.code) return;
    const languageExt: Record<string, string> = {
      typescript: 'ts',
      javascript: 'js',
      tsx: 'tsx',
      jsx: 'jsx',
      python: 'py',
      rust: 'rs',
      go: 'go',
      solidity: 'sol',
      json: 'json',
      bash: 'sh',
      sql: 'sql',
      yaml: 'yml',
    };
    const ext = languageExt[(details.language ?? '').toLowerCase()] ?? 'txt';
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
    const filename = `agent-code-${details.language || 'output'}-${stamp}.${ext}`;
    downloadTextFile(details.code, filename, 'text/plain;charset=utf-8');
  }, [details]);

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
        {t('agent.output.noMatch', { query: searchQuery })}
      </div>
    );
  }

  return (
    <div
      className="coding-container"
      id="coding-output"
      data-testid="coding-output"
      style={{
        position: 'relative',
        borderRadius: '8px',
        overflow: 'hidden',
        border: '1px solid var(--white-alpha-10)',
        backgroundColor: 'var(--surface-black)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          zIndex: 10,
          display: 'flex',
          gap: '6px',
        }}
      >
        <button
          type="button"
          onClick={handleCopy}
          className="copy-btn"
          id="btn-copy-code"
          data-testid="btn-copy-code"
          style={copied ? { ...buttonStyle, background: 'var(--success, #10b981)' } : buttonStyle}
          onMouseEnter={(e) => {
            if (!copied) e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
          }}
          onMouseLeave={(e) => {
            if (!copied) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? t('agent.coding.copied') : t('agent.coding.copyCode')}</span>
        </button>
        <button
          type="button"
          onClick={handleDownload}
          data-testid="btn-download-code"
          style={buttonHoverStyle}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.14)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
          }}
          title={t('a11y.downloadOutput')}
        >
          <Download size={12} />
          <span>{t('agent.coding.downloadCode')}</span>
        </button>
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
