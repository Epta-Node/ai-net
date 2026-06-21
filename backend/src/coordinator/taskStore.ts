import type { Task, DAGNode } from './types';

/** Volatile in-memory task store.  Swap for SQLite/Postgres in production. */
const store = new Map<string, Task>();

/** AbortControllers for in-flight task execution, allowing cancellation of running tasks. */
const abortControllers = new Map<string, AbortController>();

export function createTask(task: Task): void {
  store.set(task.taskId, task);
}

export function getTask(taskId: string): Task | undefined {
  return store.get(taskId);
}

export function updateTask(taskId: string, patch: Partial<Task>): Task {
  const existing = store.get(taskId);
  if (!existing) throw new Error(`Task ${taskId} not found`);
  const updated: Task = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  store.set(taskId, updated);
  return updated;
}

export function updateNode(taskId: string, nodeId: string, patch: Partial<DAGNode>): void {
  const task = store.get(taskId);
  if (!task) return;
  const idx = task.dag.findIndex(n => n.nodeId === nodeId);
  if (idx === -1) return;
  task.dag[idx] = { ...task.dag[idx], ...patch };
  task.updatedAt = new Date().toISOString();
}

/** Register an AbortController for a running task so it can be cancelled via DELETE. */
export function setAbortController(taskId: string, controller: AbortController): void {
  abortControllers.set(taskId, controller);
}

/** Retrieve the AbortController for a task, if one exists. */
export function getAbortController(taskId: string): AbortController | undefined {
  return abortControllers.get(taskId);
}

/** Remove the AbortController for a task once execution finishes. */
export function deleteAbortController(taskId: string): void {
  abortControllers.delete(taskId);
}

/**
 * Abort a running task by calling its AbortController.
 * Returns true if the task had an abort controller and it was aborted.
 */
export function abortTask(taskId: string): boolean {
  const controller = abortControllers.get(taskId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Cancel all pending DAG nodes for a task and update its status.
 * Used for both immediate (queued) and async (running) cancellation.
 */
export function cancelPendingNodes(taskId: string): void {
  const task = store.get(taskId);
  if (!task) return;

  for (const node of task.dag) {
    if (node.status === 'pending') {
      node.status = 'cancelled';
    }
  }
  task.status = 'cancelled';
  task.updatedAt = new Date().toISOString();
}
