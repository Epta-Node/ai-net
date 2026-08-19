import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ResearchReportResult } from '../../types/agent';
import { getMarkdown } from '../../utils/agentUtils';
import CopyButton from '../common/CopyButton';
import CollapsibleSection from '../common/CollapsibleSection';

interface Props {
  result: ResearchReportResult | null | undefined;
  searchQuery?: string;
}

const ResearchReportRenderer: React.FC<Props> = ({ result, searchQuery }) => {
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
        No research output available.
      </div>
    );
  }

  // Filter check
  const matchesSearch =
    !searchQuery || markdown.toLowerCase().includes(searchQuery.toLowerCase());

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
        No report content matching search filter "{searchQuery}".
      </div>
    );
  }

  const isLongReport = markdown.length > 500;

  const content = (
    <div
      className="markdown-body"
      id="research-markdown"
      data-testid="research-markdown"
      style={{
        color: '#f8fafc',
        lineHeight: '1.7',
        fontSize: '1rem',
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');
            if (!inline && match) {
              return (
                <div
                  style={{
                    position: 'relative',
                    margin: '16px 0',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    backgroundColor: '#1e1e1e',
                  }}
                  data-testid="code-block"
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 12px',
                      background: 'rgba(255, 255, 255, 0.04)',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                    }}
                  >
                    <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: '#94a3b8' }}>
                      {match[1]}
                    </span>
                    <CopyButton text={codeString} label="Copy" />
                  </div>
                  <SyntaxHighlighter
                    language={match[1]}
                    style={vscDarkPlus}
                    customStyle={{ margin: 0, padding: '16px', fontSize: '0.85rem' }}
                  >
                    {codeString}
                  </SyntaxHighlighter>
                </div>
              );
            }
            return (
              <code
                className={className}
                style={{
                  background: 'rgba(255, 255, 255, 0.1)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                }}
                {...props}
              >
                {children}
              </code>
            );
          },
          a({ href, children }: any) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="external-link"
                style={{ color: 'var(--accent-cyan, #38bdf8)', textDecoration: 'underline' }}
              >
                {children}
              </a>
            );
          },
          table({ children }: any) {
            return (
              <div style={{ overflowX: 'auto', margin: '20px 0' }} data-testid="markdown-table">
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '8px',
                    overflow: 'hidden',
                  }}
                >
                  {children}
                </table>
              </div>
            );
          },
          tr({ children, ...props }: any) {
            return (
              <tr
                style={{
                  borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                }}
                className="markdown-tr"
                {...props}
              >
                {children}
              </tr>
            );
          },
          th({ children }: any) {
            return (
              <th
                style={{
                  padding: '10px 14px',
                  background: 'rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-primary, #f5f7fa)',
                  fontWeight: 600,
                  textAlign: 'left',
                }}
              >
                {children}
              </th>
            );
          },
          td({ children }: any) {
            return (
              <td
                style={{
                  padding: '10px 14px',
                  color: 'var(--text-primary, #f5f7fa)',
                  fontSize: '0.9rem',
                }}
              >
                {children}
              </td>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );

  if (isLongReport) {
    return (
      <CollapsibleSection
        title="Research Report Content"
        contentLength={markdown.length}
        maxLength={500}
      >
        {content}
      </CollapsibleSection>
    );
  }

  return content;
};

export default ResearchReportRenderer;
