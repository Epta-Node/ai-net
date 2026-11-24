import { useCallback } from 'react';
import type { AgentPreference } from '../services/taskService';

export interface TaskDraft {
  prompt: string;
  maxBudgetXLM: number;
  agentPreferences: AgentPreference[];
  /** The wizard step the user was on, so returning restores their place. */
  currentStep: number;
}

export const TASK_DRAFT_STORAGE_KEY = 'task_draft_v1';

const TOTAL_STEPS = 4;
const DEFAULT_BUDGET = 0.1;

const hasStorage = (): boolean =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

/**
 * Read the persisted task wizard draft. Returns `null` when nothing is stored
 * or the entry is corrupt (so callers fall back to fresh defaults).
 */
export function loadTaskDraft(): TaskDraft | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(TASK_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TaskDraft>;

    const agentPreferences = Array.isArray(parsed.agentPreferences)
      ? (parsed.agentPreferences as unknown[]).filter(
          (value): value is AgentPreference =>
            typeof value === 'string' &&
            (value === 'research' ||
              value === 'risk' ||
              value === 'coding' ||
              value === 'design' ||
              value === 'report'),
        )
      : [];

    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      maxBudgetXLM:
        typeof parsed.maxBudgetXLM === 'number' && Number.isFinite(parsed.maxBudgetXLM)
          ? parsed.maxBudgetXLM
          : DEFAULT_BUDGET,
      agentPreferences,
      currentStep:
        typeof parsed.currentStep === 'number'
          ? Math.min(Math.max(1, Math.round(parsed.currentStep)), TOTAL_STEPS)
          : 1,
    };
  } catch {
    return null;
  }
}

export function saveTaskDraft(draft: TaskDraft): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(TASK_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Ignore write failures (e.g. sandboxed iframe or quota exceeded).
  }
}

export function clearTaskDraft(): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(TASK_DRAFT_STORAGE_KEY);
  } catch {
    // Ignore removal failures.
  }
}

/**
 * Runtime hook wrapping the draft persistence functions. Keeping a single
 * hook keeps the wizard component thin while sharing the storage key and
 * the (de)serialization logic with tests.
 */
export function useTaskDraft() {
  const save = useCallback((draft: TaskDraft) => saveTaskDraft(draft), []);
  const clear = useCallback(() => clearTaskDraft(), []);

  return { load: loadTaskDraft, save, clear };
}
