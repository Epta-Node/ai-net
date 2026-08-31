import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ResearchReportResult } from '../../types/agent';
import { getMarkdown } from '../../utils/agentUtils';

interface Props {
  result: ResearchReportResult | null | undefined;
}

interface Heading {
  level: number;
  text: string;
  id: string;
}

const ResearchReportRenderer: React.FC<Props> = ({ result }) => {
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
    <div style={{ display: 'flex', gap: '24px' }}>
      {headings.length > 0 && (
        <nav
          className="toc-sidebar"
          style={{
            position: 'sticky',
            top: '24px',
            width: '200px',
            flexShrink: 0,
            maxHeight: 'calc(100vh - 100px)',
            overflowY: 'auto',
            padding: '16px',
            background: 'rgba(255, 255, 255, 0.02)',
            borderRadius: '8px',
            border: '1px solid var(--border-color)',
            fontSize: '0.875rem',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '12px', fontSize: '0.9rem' }}>Contents</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {headings.map((h) => (
              <li
                key={h.id}
                style={{
                  marginBottom: '8px',
                  marginLeft: `${(h.level - 2) * 12}px`,
                  color: 'var(--text-secondary)',
                }}
              >
                <a
                  href={`#${h.id}`}
                  style={{
                    color: 'var(--accent-cyan)',
                    textDecoration: 'none',
                    transition: 'color 0.2s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-purple)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--accent-cyan)')}
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div
        ref={contentRef}
        className="markdown-body"
        id="research-markdown"
        style={{
          color: '#f8fafc',
          lineHeight: '1.7',
          fontSize: '1rem',
          flex: 1,
          minWidth: 0,
        }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </div>
  );
};

export default ResearchReportRenderer;
