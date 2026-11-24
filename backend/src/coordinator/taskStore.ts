import type { Task, DAGNode } from '../types/task';
import { getTaskDb, createTaskDb, type TaskEventHistoryOptions } from '../db/tasks';

function db() {
  return createTaskDb(getTaskDb());
}

// ---------------------------------------------------------------------------
// In-process AbortController registry (Issue #62)
//
// Tracks one AbortController per running task so that DELETE /api/tasks/:id
// can abort an in-flight DAG execution without a round-trip to the database.
// The map is process-local; entries are removed when the task reaches a
// terminal state (completed / failed / cancelled).
// ---------------------------------------------------------------------------

const runningControllers = new Map<string, AbortController>();

/**
 * Register an AbortController for a task that is about to start executing.
 * Called by the coordinator before invoking executeDAG.
 */
export function registerTaskController(taskId: string, controller: AbortController): void {
  runningControllers.set(taskId, controller);
}

/**
 * Remove the AbortController for a task that has reached a terminal state.
 * Called by the coordinator after executeDAG resolves or rejects.
 */
export function unregisterTaskController(taskId: string): void {
  runningControllers.delete(taskId);
}

/**
 * Abort the in-flight execution of a running task.
 * Returns true if a controller was found and signalled, false otherwise.
 */
export function abortTask(taskId: string): boolean {
  const controller = runningControllers.get(taskId);
  if (!controller) return false;
  controller.abort();
  runningControllers.delete(taskId);
  return true;
}

export function createTask(task: Task): void {
  db().insert(task);
}

export function getTask(taskId: string): Task | undefined {
  return db().findById(taskId);
}

export function updateTask(taskId: string, patch: Partial<Task>): Task {
  const existing = getTask(taskId);
  if (!existing) throw new Error(`Task ${taskId} not found`);
  const updated: Task = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  const store = db();
  if (patch.status) store.updateStatus(taskId, patch.status);
  if (patch.dag) store.updateDagJson(taskId, JSON.stringify(updated.dag));
  return updated;
}

export function updateNode(taskId: string, nodeId: string, patch: Partial<DAGNode>): void {
  const task = getTask(taskId);
  if (!task) return;
  const idx = task.dag.findIndex(n => n.nodeId === nodeId);
  if (idx === -1) return;
  task.dag[idx] = { ...task.dag[idx], ...patch };
  db().updateDagJson(taskId, JSON.stringify(task.dag));
}

export function getEventHistory(taskId: string, options?: TaskEventHistoryOptions) {
  return db().getEventHistory(taskId, options);
}
