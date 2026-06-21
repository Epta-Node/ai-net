import express, { Request, Response, NextFunction } from 'express';
import { createServer, Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

import { decompose } from '../coordinator/decompose';
import { executeDAG, type DispatchFn, type PaymentReleaseFn } from '../coordinator/coordinator';
import { createTask, getTask, setAbortController, abortTask, cancelPendingNodes } from '../coordinator/taskStore';
import { eventBus } from '../coordinator/eventBus';
import type { DAGEvent } from '../coordinator/types';

export interface AppOptions {
  /** Called to execute a single DAG node; defaults to HTTP dispatch */
  dispatch?: DispatchFn;
  /** Called after each node completes; defaults to no-op (returns 'mock-hash') */
  releasePayment?: PaymentReleaseFn;
}

export function createApp(opts: AppOptions = {}): { httpServer: HttpServer; close: () => void } {
  const app = express();
  app.use(express.json());

  const dispatch: DispatchFn = opts.dispatch ?? defaultDispatch;
  const releasePayment: PaymentReleaseFn =
    opts.releasePayment ?? (async () => 'mock-hash');

  // ── POST /api/tasks ────────────────────────────────────────────────────────
  app.post('/api/tasks', (req: Request, res: Response) => {
    const { prompt, walletPublicKey } = req.body as {
      prompt?: string;
      walletPublicKey?: string;
    };

    if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const taskId = `task_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const dag = decompose(taskId, prompt);
    const now = new Date().toISOString();

    createTask({
      taskId,
      prompt,
      walletPublicKey: walletPublicKey ?? 'anonymous',
      status: 'queued',
      dag,
      createdAt: now,
      updatedAt: now,
    });

    // Register an AbortController so DELETE can cancel this task
    const abortController = new AbortController();
    setAbortController(taskId, abortController);

    // Run the DAG asynchronously — do not await
    setImmediate(() => {
      executeDAG(getTask(taskId)!, dispatch, releasePayment, abortController.signal).catch(err => {
        console.error('[coordinator] DAG execution error:', err);
      });
    });

    return res.status(201).json({ taskId, dagPreview: dag, status: 'queued' });
  });

  // ── GET /api/tasks/:id ─────────────────────────────────────────────────────
  app.get('/api/tasks/:id', (req: Request, res: Response) => {
    const task = getTask(req.params.id!);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json(task);
  });

  // ── DELETE /api/tasks/:id ──────────────────────────────────────────────────
  app.delete('/api/tasks/:id', (req: Request, res: Response) => {
    const taskId = req.params.id!;
    const task = getTask(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    switch (task.status) {
      case 'queued': {
        // Queued task: cancel immediately — no nodes are running yet
        cancelPendingNodes(taskId);
        const now = new Date().toISOString();
        eventBus.emit(taskId, {
          type: 'task_cancelled',
          taskId,
          timestamp: now,
        });
        return res.json({ status: 'cancelled' });
      }

      case 'running': {
        // Running task: signal the abort controller (async cancellation)
        const aborted = abortTask(taskId);
        if (!aborted) {
          return res.status(409).json({ error: 'Task is already completing' });
        }
        return res.status(200).json({ status: 'cancelling' });
      }

      case 'completed':
      case 'failed':
      case 'cancelled':
        return res.status(409).json({ error: `Task already ${task.status}` });
    }
  });

  // ── HTTP server ────────────────────────────────────────────────────────────
  const httpServer = createServer(app);

  // ── WebSocket: /tasks/:id/stream ───────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    const match = url.match(/^\/tasks\/([^/]+)\/stream$/);
    if (!match) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req, match[1]);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: unknown, taskId: string) => {
    const task = getTask(taskId);
    if (!task) {
      ws.close(4004, 'Task not found');
      return;
    }

    // Subscribe before replay so no live events are missed in the window between
    const unsub = eventBus.subscribe(taskId, (event: DAGEvent) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });

    // Replay past events derived from current DAG + task state
    for (const node of task.dag) {
      if (node.status === 'running' || node.status === 'completed' || node.status === 'failed') {
        ws.send(JSON.stringify({ type: 'node_started',    taskId, nodeId: node.nodeId, timestamp: task.updatedAt }));
      }
      if (node.status === 'completed') {
        ws.send(JSON.stringify({ type: 'payment_released', taskId, nodeId: node.nodeId, timestamp: task.updatedAt }));
        ws.send(JSON.stringify({ type: 'node_completed',  taskId, nodeId: node.nodeId, timestamp: task.updatedAt }));
      }
      if (node.status === 'failed') {
        ws.send(JSON.stringify({ type: 'node_failed', taskId, nodeId: node.nodeId, timestamp: task.updatedAt }));
      }
    }

    // If the task is already terminal, synthesize the final event so clients can exit
    if (task.status === 'completed') {
      ws.send(JSON.stringify({ type: 'task_completed', taskId, timestamp: task.updatedAt }));
    } else if (task.status === 'failed') {
      ws.send(JSON.stringify({ type: 'task_failed', taskId, timestamp: task.updatedAt }));
    } else if (task.status === 'cancelled') {
      ws.send(JSON.stringify({ type: 'task_cancelled', taskId, timestamp: task.updatedAt }));
    }

    ws.on('close', unsub);
    ws.on('error', unsub);
  });

  function close(): void {
    wss.close();
    httpServer.close();
  }

  return { httpServer, close };
}

async function defaultDispatch(
  taskId: string,
  node: { nodeId: string; agentType: string; prompt: string },
  context: string
): Promise<unknown> {
  // In production this POSTs to the agent's HTTP endpoint.
  // The e2e test replaces this via opts.dispatch.
  throw new Error(`No agent registered for type: ${node.agentType}`);
}
