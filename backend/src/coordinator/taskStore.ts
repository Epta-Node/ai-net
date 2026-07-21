import type { Task, DAGNode } from '../types/task';
import { getTaskDb, createTaskDb } from '../db/tasks';

function db() {
  return createTaskDb(getTaskDb());
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

export function getEventHistory(taskId: string) {
  return db().getEventHistory(taskId);
}
