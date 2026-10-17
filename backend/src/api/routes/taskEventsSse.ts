import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { StoredEvent } from "../../events/eventStore";
import { getTask as defaultGetTask } from "../../coordinator/taskStore";
import { getConfig } from "../../config";
import { AppError, ForbiddenError, NotFoundError, RateLimitError } from "../../errors";
import { isEnabled } from "../../services/featureFlags";
import { createLogger } from "../../utils/logger";
import type { Task } from "../../types/task";
import { toWireEvent } from "./stream";
import type { TaskStreamHub } from "./taskStreamHub";

const logger = createLogger({ module: "sse-stream" });

/** Wire event types after which a task produces no further events. */
const TERMINAL_EVENT_TYPES = new Set(["task_completed", "task_failed"]);

export interface TaskEventsSseOptions {
  /** Shared fan-out hub, the same one the WebSocket stream reads through. */
  hub: TaskStreamHub;
  getTask?: (taskId: string) => Task | undefined;
  /** Interval between `: keep-alive` comments. Default `SSE_HEARTBEAT_INTERVAL_MS`. */
  heartbeatIntervalMs?: number;
  /** Concurrent streams allowed per client IP. Default `SSE_MAX_CONNECTIONS_PER_CLIENT`. */
  maxConnectionsPerClient?: number;
}

/**
 * Resume cursor from the `Last-Event-ID` header (sent automatically by
 * `EventSource` on reconnect) or the `lastEventId` query param. Malformed
 * values are ignored, giving a full replay — the same rule as the WebSocket.
 */
function parseResumeCursor(req: Request): number | undefined {
  const header = req.headers["last-event-id"];
  const raw = (Array.isArray(header) ? header[0] : header) ?? req.query.lastEventId;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * @openapi
 * /api/tasks/{id}/events/stream:
 *   get:
 *     summary: Server-Sent Events stream of task execution events
 *     description: >
 *       Replays stored events after the resume cursor, then streams live ones.
 *       Each message carries `id: <seq>`, so `EventSource` resumes through the
 *       `Last-Event-ID` header on reconnect. A `: keep-alive` comment is sent
 *       periodically and the stream ends after `task_completed` / `task_failed`.
 *       Returns 404 while the `streaming_responses` feature flag is off.
 *     tags: [Tasks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: walletpublickey
 *         required: true
 *         schema: { type: string }
 *         description: Wallet that owns the task
 *       - in: header
 *         name: Last-Event-ID
 *         required: false
 *         schema: { type: integer, minimum: 0 }
 *         description: Resume after this event seq
 *     responses:
 *       200:
 *         description: text/event-stream of task events
 *       403:
 *         description: Wallet does not own the task
 *       404:
 *         description: Task not found, or streaming responses are disabled
 *       429:
 *         description: Too many concurrent streams for this client
 */
export function createTaskEventsSseHandler(options: TaskEventsSseOptions): RequestHandler {
  const { hub, getTask = defaultGetTask } = options;
  const connectionsByClient = new Map<string, number>();

  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (!isEnabled("streaming_responses")) {
        throw new AppError("Streaming responses are disabled", 404, "NOT_FOUND", {
          feature: "streaming_responses",
        });
      }

      const taskId = req.params.id;
      const task = getTask(taskId);
      if (!task) throw new NotFoundError("Task", taskId);

      const requesterKey = req.headers["walletpublickey"] as string | undefined;
      if (!requesterKey || requesterKey !== task.walletPublicKey) {
        throw new ForbiddenError("Access denied");
      }

      const cfg = getConfig();
      const maxConnections =
        options.maxConnectionsPerClient ?? cfg.SSE_MAX_CONNECTIONS_PER_CLIENT;
      const heartbeatMs = options.heartbeatIntervalMs ?? cfg.SSE_HEARTBEAT_INTERVAL_MS;

      const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const open = connectionsByClient.get(clientIp) ?? 0;
      if (open >= maxConnections) {
        logger.warn({ clientIp, taskId }, "SSE connection limit exceeded");
        throw new RateLimitError("Too many concurrent event streams");
      }
      connectionsByClient.set(clientIp, open + 1);

      res.status(200).set({
        "Content-Type": "text/event-stream",
        // no-transform keeps compression middleware from buffering the stream.
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      let closed = false;
      let unsubscribe: (() => void) | undefined;
      const heartbeat = setInterval(() => {
        if (!closed) res.write(": keep-alive\n\n");
      }, heartbeatMs);

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        const remaining = (connectionsByClient.get(clientIp) ?? 1) - 1;
        if (remaining <= 0) connectionsByClient.delete(clientIp);
        else connectionsByClient.set(clientIp, remaining);
      };
      res.on("close", cleanup);

      let finished = false;
      const deliver = (event: StoredEvent): void => {
        if (closed || finished) return;
        const wire = toWireEvent(event) as { type: string; seq: number };
        res.write(`id: ${wire.seq}\nevent: ${wire.type}\ndata: ${JSON.stringify(wire)}\n\n`);
        if (TERMINAL_EVENT_TYPES.has(wire.type)) {
          finished = true;
          cleanup();
          res.end();
        }
      };

      // Subscribe, then drain the backlog through the shared hub (bounded pages).
      unsubscribe = hub.subscribe(taskId, { lastEventId: parseResumeCursor(req) }, deliver);
      if (closed) unsubscribe();
      else hub.flush(taskId);
    } catch (err) {
      next(err);
    }
  };
}
