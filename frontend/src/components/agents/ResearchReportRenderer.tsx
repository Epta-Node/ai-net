import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Download } from 'lucide-react';
import { ResearchReportResult } from '../../types/agent';
import { getMarkdown } from '../../utils/agentUtils';
import { downloadTextFile, buildOutputFilename } from '../../utils/download';
import CopyButton from '../common/CopyButton';
import CollapsibleSection from '../common/CollapsibleSection';

interface Props {
  result: ResearchReportResult | null | undefined;
  searchQuery?: string;
}

interface Heading {
  level: number;
  text: string;
  id: string;
}

const tocLinkStyle: React.CSSProperties = {
  display: 'block',
  padding: '2px 0',
  fontSize: '0.75rem',
  color: 'var(--accent-cyan, #38bdf8)',
  textDecoration: 'none',
  cursor: 'pointer',
  background: 'none',
  border: 'none',
  textAlign: 'left',
};

const ResearchReportRenderer: React.FC<Props> = ({ result, searchQuery }) => {
  const { t } = useTranslation();
  const markdown = getMarkdown(result);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contentRef.current) return;

    const headingElements = contentRef.current.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const headingList: Heading[] = [];
    let h2Count = 0;
    let h3Count = 0;

    headingElements.forEach((heading, idx) => {
      const level = parseInt(heading.tagName[1]);
      const text = heading.textContent || '';
      const id = `heading-${idx}`;

      if (level === 2) {
        h2Count++;
        h3Count = 0;
        heading.textContent = `${h2Count}. ${text}`;
      } else if (level === 3) {
        h3Count++;
        heading.textContent = `${h2Count}.${h3Count} ${text}`;
      }

      heading.id = id;
      heading.classList.add('report-heading');

      const link = document.createElement('a');
      link.href = `#${id}`;
      link.className = 'heading-anchor';
      link.setAttribute('aria-label', `Link to ${text}`);
      link.innerHTML = '🔗';
      heading.appendChild(link);

      if (level <= 3) {
        headingList.push({ level, text, id });
      }
    });

    setHeadings(headingList);
  }, [markdown]);

  if (!markdown) {
    return (
      <div
        className="empty-state"
        id="empty-research"
        style={{
          padding: '24px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          background: 'var(--white-alpha-02)',
          borderRadius: '8px',
          border: '1px dashed var(--white-alpha-10)',
        }}
      >
        {t('agent.research.empty')}
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
        {t('agent.output.noMatch', { query: searchQuery })}
      </div>
    );
  }

  const isLongReport = markdown.length > 500;

  // A report is prose, so the export is the markdown source verbatim — that
  // round-trips through any markdown tool rather than through a screenshot.
  const handleDownload = () => {
    downloadTextFile(
      markdown,
      buildOutputFilename('agent-report', 'markdown'),
      'text/markdown;charset=utf-8',
    );
  };

  /** Scroll a heading into view and move focus so keyboard users follow along. */
  const jumpTo = (id: string) => {
    const target = contentRef.current?.querySelector(`#${CSS.escape(id)}`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
  };

  const content = (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          marginBottom: '12px',
        }}
      >
        {headings.length > 2 ? (
          <nav aria-label={t('agent.research.tableOfContents')} data-testid="report-toc">
            <details>
              <summary
                style={{
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                }}
              >
                {t('agent.research.tableOfContents')}
              </summary>
              <div style={{ marginTop: '6px' }}>
                {headings.map((heading) => (
                  <button
                    key={heading.id}
                    type="button"
                    style={{ ...tocLinkStyle, paddingLeft: `${(heading.level - 1) * 10}px` }}
                    onClick={() => jumpTo(heading.id)}
                  >
                    {heading.text}
                  </button>
                ))}
              </div>
            </details>
          </nav>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={handleDownload}
          data-testid="btn-download-report"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            padding: '5px 10px',
            fontSize: '0.75rem',
            fontWeight: 600,
            color: 'var(--text-secondary, #cbd5e1)',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid var(--white-alpha-10, rgba(255,255,255,0.12))',
            borderRadius: '6px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
          title={t('a11y.downloadOutput')}
        >
          <Download size={12} />
          <span>{t('task.output.downloadMarkdown')}</span>
        </button>
      </div>
      <div
        className="markdown-body"
        id="research-markdown"
        data-testid="research-markdown"
        ref={contentRef}
        style={{
          color: 'var(--surface-primary)',
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
                style={{ color: 'var(--accent-info)', textDecoration: 'underline' }}
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
                  color: 'var(--text-primary)',
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
                  color: 'var(--text-primary)',
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
    </>
  );

  if (isLongReport) {
    return (
      <CollapsibleSection
        title={t('agent.research.contentTitle')}
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
