import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTaskDraft,
  loadTaskDraft,
  saveTaskDraft,
  TASK_DRAFT_STORAGE_KEY,
  type TaskDraft,
} from './useTaskDraft';

const draft: TaskDraft = {
  prompt: 'Build a testing suite',
  maxBudgetXLM: 2.5,
  agentPreferences: ['research', 'coding'],
  currentStep: 3,
};

describe('useTaskDraft persistence', () => {
  beforeEach(() => {
    clearTaskDraft();
  });

  it('returns null when nothing is stored', () => {
    expect(loadTaskDraft()).toBeNull();
  });

  it('round-trips a draft through localStorage', () => {
    saveTaskDraft(draft);
    expect(loadTaskDraft()).toEqual(draft);
  });

  it('clears the stored draft', () => {
    saveTaskDraft(draft);
    clearTaskDraft();
    expect(loadTaskDraft()).toBeNull();
    expect(window.localStorage.getItem(TASK_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('restores a draft with a saved current step (navigation restore)', () => {
    saveTaskDraft({ ...draft, currentStep: 4 });
    expect(loadTaskDraft()?.currentStep).toBe(4);
  });

  it('falls back to fresh defaults on a corrupt entry', () => {
    window.localStorage.setItem(TASK_DRAFT_STORAGE_KEY, '{not json');
    const loaded = loadTaskDraft();
    expect(loaded).toBeNull();
  });

  it('clamps an out-of-range stored step into [1, 4]', () => {
    saveTaskDraft({ ...draft, currentStep: 99 });
    expect(loadTaskDraft()?.currentStep).toBe(4);
  });

  it('filters out unknown agent preference values from a stored draft', () => {
    saveTaskDraft({
      ...draft,
      agentPreferences: ['research', 'not-a-real-agent'],
    });
    expect(loadTaskDraft()?.agentPreferences).toEqual(['research']);
  });
});
