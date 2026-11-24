import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Braces, Check, Copy, Download, FileCode2, FileText, type LucideIcon } from 'lucide-react';
import {
  copyToClipboard,
  downloadTextFile,
  buildOutputFilename,
  extensionForFormat,
  type ExportFormat,
} from '../../utils/download';
import styles from './AgentOutputViewer.module.css';

/** The three presentations issue #400 asks for, in tab order. */
type OutputTab = 'json' | 'markdown' | 'text';

const TAB_ORDER: OutputTab[] = ['json', 'markdown', 'text'];

const TAB_ICONS: Record<OutputTab, LucideIcon> = {
  json: Braces,
  markdown: FileText,
  text: FileCode2,
};

/** Syntax-highlighter language ids per tab. */
const TAB_LANGUAGE: Record<OutputTab, string> = {
  json: 'json',
  markdown: 'markdown',
  text: 'text',
};

interface AgentOutputViewerProps {
  /** Raw output exactly as the agent produced it. */
  output: string;
  /** Filename stem, e.g. `agent-output-node-research`. */
  filenameBase: string;
  /** Forces a single tab (e.g. code output, which is not JSON or markdown). */
  forcedTab?: OutputTab;
  /** Hides the format tabs when there is only one meaningful presentation. */
  hideTabs?: boolean;
}

/**
 * Split raw agent output into the three presentations the panel offers.
 *
 * Tabs are always all present so the tab bar never reflows as a task streams
 * output in; a tab that has no content renders an explicit empty state instead
 * of disappearing. The JSON tab is only populated when the output actually
 * parses — a half-written JSON stream is far more useful read as text than
 * shown as a syntax error.
 */
function deriveTabs(output: string): Record<OutputTab, string> {
  const trimmed = output.trim();
  let json = '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      // Re-serialising normalises whitespace so the JSON view is always
      // pretty-printed regardless of how the agent emitted it.
      json = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      json = '';
    }
  }
  return { json, markdown: output, text: output };
}

/**
 * Tabbed, syntax-highlighted view of an agent's output with copy and download.
 *
 * Shared by the dashboard task panel and the per-agent renderer so both
 * surfaces behave identically — the acceptance criteria for #400 ("output
 * types render correctly with highlighting", "download produces correct
 * filename and format") should hold everywhere an output is shown.
 */
export const AgentOutputViewer: React.FC<AgentOutputViewerProps> = ({
  output,
  filenameBase,
  forcedTab,
  hideTabs = false,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<OutputTab>(forcedTab ?? 'markdown');
  const [copied, setCopied] = useState(false);

  const tabs = useMemo(() => deriveTabs(output), [output]);
  const currentTab = forcedTab ?? activeTab;
  const currentContent = tabs[currentTab];

  const handleCopy = useCallback(async () => {
    if (!currentContent) return;
    const ok = await copyToClipboard(currentContent);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [currentContent]);

  const handleDownload = useCallback(() => {
    if (!currentContent) return;
    const format: ExportFormat =
      currentTab === 'markdown' ? 'markdown' : currentTab === 'json' ? 'json' : 'text';
    downloadTextFile(
      currentContent,
      buildOutputFilename(filenameBase, format),
      `${extensionForFormat(format) === 'json' ? 'application/json' : 'text/plain'};charset=utf-8`,
    );
  }, [currentContent, currentTab, filenameBase]);

  const downloadLabel = t(`task.output.download${currentTab.charAt(0).toUpperCase()}${currentTab.slice(1)}` as const);

  return (
    <div className={styles.viewer} data-testid="agent-output-viewer">
      <div className={styles.toolbar}>
        {hideTabs ? (
          <span className={styles.tab} aria-hidden="true">
            {t(`task.output.tab${currentTab.charAt(0).toUpperCase()}${currentTab.slice(1)}` as const)}
          </span>
        ) : (
          <div
            className={styles.tabs}
            role="tablist"
            aria-label={t('a11y.outputFormatTabs')}
            data-testid="output-format-tabs"
          >
            {TAB_ORDER.map((tab) => {
              const Icon = TAB_ICONS[tab];
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`output-tab-${tab}`}
                  aria-selected={currentTab === tab}
                  aria-controls={`output-panel-${tab}`}
                  tabIndex={currentTab === tab ? 0 : -1}
                  className={styles.tab}
                  onClick={() => setActiveTab(tab)}
                  data-testid={`output-tab-${tab}`}
                >
                  <Icon size={12} />
                  <span>{t(`task.output.tab${tab.charAt(0).toUpperCase()}${tab.slice(1)}` as const)}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            onClick={handleCopy}
            disabled={!currentContent}
            data-testid="output-copy-btn"
            title={t('a11y.copyOutput')}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span>{copied ? t('task.output.copied') : t('task.output.copy')}</span>
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={handleDownload}
            disabled={!currentContent}
            data-testid="output-download-btn"
            title={t('a11y.downloadOutput')}
          >
            <Download size={13} />
            <span>{downloadLabel}</span>
          </button>
        </div>
      </div>

      <div
        className={styles.body}
        role="tabpanel"
        id={`output-panel-${currentTab}`}
        aria-labelledby={`output-tab-${currentTab}`}
        data-testid="output-panel"
      >
        {currentContent ? (
          <SyntaxHighlighter
            language={TAB_LANGUAGE[currentTab]}
            style={vscDarkPlus}
            wrapLongLines
            customStyle={{
              margin: 0,
              padding: '14px 16px',
              fontSize: '0.8rem',
              lineHeight: 1.55,
              backgroundColor: 'transparent',
            }}
          >
            {currentContent}
          </SyntaxHighlighter>
        ) : (
          <p className={styles.empty} data-testid="output-tab-empty">
            {t('task.output.emptyTab', {
              format: t(`task.output.tab${currentTab.charAt(0).toUpperCase()}${currentTab.slice(1)}` as const),
            })}
          </p>
        )}
      </div>
    </div>
  );
};

export default AgentOutputViewer;
