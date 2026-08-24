import React, { useState } from 'react';
import {
  X,
  Clock,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowLeftRight,
  AlertCircle,
} from 'lucide-react';
import type { TaskResponse } from '../../types/api';
import {
  getTaskDuration,
  getTaskCost,
  getTaskAgentTypes,
  formatDuration,
} from '../../hooks/useTaskHistory';
import styles from './TaskComparison.module.css';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AGENT_COLORS: Record<string, string> = {
  research: '#38bdf8',
  risk: '#f59e0b',
  coding: '#a78bfa',
  design: '#f472b6',
  report: '#34d399',
};

function statusColor(status: TaskResponse['status']): string {
  switch (status) {
    case 'completed': return '#34d399';
    case 'failed': return '#f87171';
    case 'running': return '#818cf8';
    default: return '#fbbf24';
  }
}

function statusIcon(status: TaskResponse['status']): React.ReactNode {
  switch (status) {
    case 'completed': return <CheckCircle2 size={15} />;
    case 'failed': return <XCircle size={15} />;
    case 'running': return <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />;
    default: return <Clock size={15} />;
  }
}

/** Render a DAG node result as a readable string */
function renderNodeResult(result: unknown): string {
  if (result === null || result === undefined) return '—';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.summary === 'string') return r.summary;
    if (typeof r.markdown === 'string') return r.markdown;
    if (typeof r.content === 'string') return r.content;
    if (typeof r.code === 'string') return `\`\`\`\n${r.code}\n\`\`\``;
    try { return JSON.stringify(result, null, 2); } catch { return String(result); }
  }
  return String(result);
}

// ─── Diff highlight ───────────────────────────────────────────────────────────

/** Simple word-level diff: return JSX with changed words highlighted */
function DiffText({
  textA,
  textB,
  isA,
}: {
  textA: string;
  textB: string;
  isA: boolean;
}): React.ReactElement {
  const wordsA = textA.split(/\s+/);
  const wordsB = textB.split(/\s+/);
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const words = isA ? wordsA : wordsB;
  const other = isA ? setB : setA;

  return (
    <>
      {words.map((word, i) => {
        const isDiff = word.length > 2 && !other.has(word);
        return isDiff ? (
          <mark key={i} className={styles.diffMark}>
            {word}{' '}
          </mark>
        ) : (
          <React.Fragment key={i}>{word} </React.Fragment>
        );
      })}
    </>
  );
}

// ─── Comparison column ────────────────────────────────────────────────────────

interface ComparisonColumnProps {
  task: TaskResponse;
  label: 'A' | 'B';
  otherTask: TaskResponse;
  showDiff: boolean;
}

const ComparisonColumn: React.FC<ComparisonColumnProps> = ({
  task,
  label,
  otherTask,
  showDiff,
}) => {
  const taskId = task.taskId || task.id || '';
  const duration = getTaskDuration(task);
  const cost = getTaskCost(task);
  const agentTypes = getTaskAgentTypes(task);

  return (
    <div className={`${styles.column} ${label === 'A' ? styles.columnA : styles.columnB}`}>
      {/* Column header */}
      <div className={styles.colHeader}>
        <span className={styles.colLabel}>{label}</span>
        <div className={styles.colMeta}>
          <span
            className={styles.colStatus}
            style={{ color: statusColor(task.status) }}
            aria-label={`Status: ${task.status}`}
          >
            {statusIcon(task.status)}
            <span className={styles.colStatusText}>{task.status}</span>
          </span>
          <span className={styles.colDate}>
            {new Date(task.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </span>
        </div>
        <span className={styles.colId} title={taskId}>
          #{taskId.slice(-12)}
        </span>
      </div>

      {/* Prompt */}
      <section className={styles.section} aria-labelledby={`prompt-${label}`}>
        <h4 id={`prompt-${label}`} className={styles.sectionTitle}>Prompt</h4>
        <div className={styles.sectionBody}>
          {showDiff ? (
            <p className={styles.promptText}>
              <DiffText
                textA={task.prompt || ''}
                textB={otherTask.prompt || ''}
                isA={label === 'A'}
              />
            </p>
          ) : (
            <p className={styles.promptText}>{task.prompt || '—'}</p>
          )}
        </div>
      </section>

      {/* Stats */}
      <section className={styles.section} aria-labelledby={`stats-${label}`}>
        <h4 id={`stats-${label}`} className={styles.sectionTitle}>Metrics</h4>
        <div className={styles.statsGrid}>
          <div className={styles.statCell}>
            <span className={styles.statLabel}>Duration</span>
            <span className={styles.statValue}>
              {duration !== undefined ? formatDuration(duration) : '—'}
            </span>
          </div>
          <div className={styles.statCell}>
            <span className={styles.statLabel}>Est. Cost</span>
            <span className={styles.statValue}>{cost > 0 ? `${cost.toFixed(2)} XLM` : '—'}</span>
          </div>
          <div className={styles.statCell}>
            <span className={styles.statLabel}>Nodes</span>
            <span className={styles.statValue}>{task.dag?.length ?? 0}</span>
          </div>
          <div className={styles.statCell}>
            <span className={styles.statLabel}>Agents</span>
            <div className={styles.statAgents}>
              {agentTypes.length === 0
                ? <span className={styles.statValue}>—</span>
                : agentTypes.map((t) => (
                  <span
                    key={t}
                    className={styles.agentPill}
                    style={{ color: AGENT_COLORS[t] || '#94a3b8', borderColor: `${AGENT_COLORS[t] || '#94a3b8'}44` }}
                  >
                    {t}
                  </span>
                ))}
            </div>
          </div>
        </div>
      </section>

      {/* Agent outputs */}
      {task.dag && task.dag.length > 0 && (
        <section className={styles.section} aria-labelledby={`outputs-${label}`}>
          <h4 id={`outputs-${label}`} className={styles.sectionTitle}>Agent Outputs</h4>
          <div className={styles.outputList}>
            {task.dag.map((node, i) => {
              const resultText = renderNodeResult(node.result);
              const agentBase = (node.agentType || '').toLowerCase();
              const agentKey = ['research', 'risk', 'coding', 'design', 'report'].find((k) =>
                agentBase.includes(k)
              );
              const agentColor = agentKey ? AGENT_COLORS[agentKey] : '#94a3b8';

              // Find corresponding node in other task for diff
              const otherNode = otherTask.dag?.[i];
              const otherResultText = otherNode ? renderNodeResult(otherNode.result) : '';

              return (
                <div key={node.nodeId || i} className={styles.outputNode}>
                  <div className={styles.outputNodeHeader}>
                    <span
                      className={styles.outputNodeName}
                      style={{ color: agentColor }}
                    >
                      {node.nodeId.replace(/^node[_-]/, '')} ({node.agentType || 'agent'})
                    </span>
                    <span
                      className={styles.outputNodeStatus}
                      style={{ color: statusColor(node.status as TaskResponse['status']) }}
                    >
                      {node.status}
                    </span>
                  </div>

                  {node.error ? (
                    <div className={styles.outputError}>
                      <AlertCircle size={12} aria-hidden="true" />
                      {node.error}
                    </div>
                  ) : (
                    <pre className={styles.outputPre}>
                      {showDiff && otherResultText ? (
                        <DiffText
                          textA={resultText}
                          textB={otherResultText}
                          isA={label === 'A'}
                        />
                      ) : (
                        resultText.slice(0, 600) + (resultText.length > 600 ? '…' : '')
                      )}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};

// ─── Markdown export ──────────────────────────────────────────────────────────

function buildMarkdownReport(taskA: TaskResponse, taskB: TaskResponse): string {
  const idA = taskA.taskId || taskA.id || 'A';
  const idB = taskB.taskId || taskB.id || 'B';
  const durationA = getTaskDuration(taskA);
  const durationB = getTaskDuration(taskB);
  const costA = getTaskCost(taskA);
  const costB = getTaskCost(taskB);

  const lines: string[] = [
    '# Task Comparison Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '---',
    '',
    '## Summary',
    '',
    `| | Task A | Task B |`,
    `|---|---|---|`,
    `| **ID** | \`${idA}\` | \`${idB}\` |`,
    `| **Status** | ${taskA.status} | ${taskB.status} |`,
    `| **Created** | ${new Date(taskA.createdAt).toLocaleString()} | ${new Date(taskB.createdAt).toLocaleString()} |`,
    `| **Duration** | ${durationA !== undefined ? formatDuration(durationA) : '—'} | ${durationB !== undefined ? formatDuration(durationB) : '—'} |`,
    `| **Est. Cost** | ${costA > 0 ? `${costA.toFixed(2)} XLM` : '—'} | ${costB > 0 ? `${costB.toFixed(2)} XLM` : '—'} |`,
    `| **Nodes** | ${taskA.dag?.length ?? 0} | ${taskB.dag?.length ?? 0} |`,
    '',
    '---',
    '',
    '## Prompts',
    '',
    '### Task A',
    '',
    taskA.prompt || '—',
    '',
    '### Task B',
    '',
    taskB.prompt || '—',
    '',
    '---',
    '',
    '## Agent Outputs',
    '',
  ];

  // Output for each task
  for (const [label, task] of [['A', taskA], ['B', taskB]] as const) {
    lines.push(`### Task ${label} Outputs`);
    lines.push('');
    if (task.dag && task.dag.length > 0) {
      task.dag.forEach((node) => {
        lines.push(`#### ${node.nodeId} (${node.agentType || 'agent'}) — ${node.status}`);
        lines.push('');
        if (node.error) {
          lines.push(`**Error:** ${node.error}`);
        } else {
          const result = renderNodeResult(node.result);
          lines.push('```');
          lines.push(result.slice(0, 1000) + (result.length > 1000 ? '\n…(truncated)' : ''));
          lines.push('```');
        }
        lines.push('');
      });
    } else {
      lines.push('No DAG nodes recorded.');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function downloadMarkdown(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

// ─── Main component ───────────────────────────────────────────────────────────

interface TaskComparisonProps {
  taskA: TaskResponse;
  taskB: TaskResponse;
  onClose: () => void;
}

export const TaskComparison: React.FC<TaskComparisonProps> = ({
  taskA,
  taskB,
  onClose,
}) => {
  const [showDiff, setShowDiff] = useState(false);

  const idA = taskA.taskId || taskA.id || 'A';
  const idB = taskB.taskId || taskB.id || 'B';

  const handleExport = () => {
    const md = buildMarkdownReport(taskA, taskB);
    downloadMarkdown(md, `task-comparison-${idA.slice(-6)}-vs-${idB.slice(-6)}.md`);
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Task comparison">
      {/* Backdrop */}
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />

      <div className={styles.panel}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <ArrowLeftRight size={18} className={styles.headerIcon} aria-hidden="true" />
            <h2 className={styles.headerTitle}>Comparison</h2>
            <span className={styles.headerSubtitle}>
              #{idA.slice(-8)} vs #{idB.slice(-8)}
            </span>
          </div>

          <div className={styles.headerActions}>
            {/* Diff toggle */}
            <label className={styles.diffToggle}>
              <input
                type="checkbox"
                checked={showDiff}
                onChange={(e) => setShowDiff(e.target.checked)}
                aria-label="Highlight differences between tasks"
              />
              <span className={styles.diffLabel}>Show diff</span>
            </label>

            {/* Export */}
            <button
              type="button"
              className={styles.exportBtn}
              onClick={handleExport}
              aria-label="Export comparison as markdown"
            >
              <Download size={14} />
              Export MD
            </button>

            {/* Close */}
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="Close comparison"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Split view */}
        <div className={styles.splitView}>
          <ComparisonColumn
            task={taskA}
            label="A"
            otherTask={taskB}
            showDiff={showDiff}
          />

          {/* Divider */}
          <div className={styles.divider} aria-hidden="true" />

          <ComparisonColumn
            task={taskB}
            label="B"
            otherTask={taskA}
            showDiff={showDiff}
          />
        </div>
      </div>
    </div>
  );
};
