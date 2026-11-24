import { useEffect, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { nodeDurationMs, type NodeExecInfo } from '../../utils/buildLiveDag';
import './dagNodeStatus.css';

export const NODE_INPUT_PREVIEW_CHARS = 500;

export interface NodePanelProps {
  agentName: string;
  agentType?: string;
  walletAddress?: string;
  input?: string;
  /** Venice token cost for this node, if reported. */
  tokenCost?: number;
  exec: NodeExecInfo;
  onClose: () => void;
}

/**
 * Side panel with the details of one DAG node (#818). Closes on Esc or the
 * close button; useFocusTrap returns focus to the node that opened it.
 */
export function NodePanel({
  agentName,
  agentType,
  walletAddress,
  input,
  tokenCost,
  exec,
  onClose,
}: NodePanelProps) {
  const ref = useFocusTrap<HTMLElement>(true);
  const [expanded, setExpanded] = useState(false);
  const duration = nodeDurationMs(exec);
  const truncated = !!input && input.length > NODE_INPUT_PREVIEW_CHARS && !expanded;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby="node-panel-title"
      data-state={exec.state}
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(420px, 100vw)',
        overflowY: 'auto',
        padding: 'var(--space-4)',
        background: 'var(--surface-elevated)',
        color: 'var(--text-primary)',
        borderLeft: '1px solid var(--border-primary)',
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
        <h2 id="node-panel-title">{agentName}</h2>
        <button type="button" onClick={onClose} aria-label="Close node details">
          ×
        </button>
      </header>
      <dl>
        {agentType && (
          <>
            <dt>Type</dt>
            <dd>{agentType}</dd>
          </>
        )}
        {walletAddress && (
          <>
            <dt>Wallet</dt>
            <dd style={{ wordBreak: 'break-all' }}>{walletAddress}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>{exec.state}</dd>
        {duration !== undefined && (
          <>
            <dt>Duration</dt>
            <dd>{(duration / 1000).toFixed(1)}s</dd>
          </>
        )}
        {tokenCost !== undefined && (
          <>
            <dt>Venice token cost</dt>
            <dd>{tokenCost}</dd>
          </>
        )}
      </dl>
      {input && (
        <section>
          <h3>Input</h3>
          <pre style={{ whiteSpace: 'pre-wrap' }}>
            {truncated ? `${input.slice(0, NODE_INPUT_PREVIEW_CHARS)}…` : input}
          </pre>
          {input.length > NODE_INPUT_PREVIEW_CHARS && (
            <button type="button" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show less' : 'Show full input'}
            </button>
          )}
        </section>
      )}
      {exec.state === 'failed' && exec.error && (
        <section>
          <h3>Error</h3>
          <p role="alert" style={{ color: 'var(--status-danger-text)' }}>
            {exec.error}
          </p>
        </section>
      )}
      {exec.output && (
        <section>
          <h3>Output</h3>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{exec.output}</pre>
        </section>
      )}
    </aside>
  );
}

export default NodePanel;
