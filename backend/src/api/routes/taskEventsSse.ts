import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { StoredEvent } from "../../events/eventStore";
import { getTask as defaultGetTask } from "../../coordinator/taskStore";
import { getConfig } from "../../config";
import { AppError, ForbiddenError, NotFoundError, RateLimitError } from "../../errors";
import { isEnabled } from "../../services/featureFlags";
import {
  recordSseConnectionClosed,
  recordSseConnectionOpened,
  recordSseConnectionTimedOut,
  recordSseEventDropped,
  recordSseEventSent,
} from "../../services/sseMetrics";
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
  /**
   * Socket write-buffer size above which events are dropped for a slow client.
   * Default `SSE_HIGH_WATER_MARK_BYTES` (#813).
   */
  highWaterMarkBytes?: number;
  /**
   * Close the stream with `stream_timeout` after this long without a successful
   * write. Default `SSE_STALE_CONNECTION_TIMEOUT_MS` (#813).
   */
  staleTimeoutMs?: number;
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
 *       A client that stops accepting writes stops receiving events once its
 *       buffer passes the high-water mark, and is closed with a `stream_timeout`
 *       event after `SSE_STALE_CONNECTION_TIMEOUT_MS` without progress.
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
      const highWaterMarkBytes = options.highWaterMarkBytes ?? cfg.SSE_HIGH_WATER_MARK_BYTES;
      const staleTimeoutMs = options.staleTimeoutMs ?? cfg.SSE_STALE_CONNECTION_TIMEOUT_MS;

      const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const open = connectionsByClient.get(clientIp) ?? 0;
      if (open >= maxConnections) {
        logger.warn({ clientIp, taskId }, "SSE connection limit exceeded");
        throw new RateLimitError("Too many concurrent event streams");
      }
      connectionsByClient.set(clientIp, open + 1);
      recordSseConnectionOpened();

      res.status(200).set({
        "Content-Type": "text/event-stream",
        // no-transform keeps compression middleware from buffering the stream.
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      let closed = false;
      // Assigned after `cleanup` is defined so an early close can call it;
      // `const` would put the reference in the temporal dead zone.
      // eslint-disable-next-line prefer-const
      let unsubscribe: (() => void) | undefined;
      // Time of the last write the socket accepted (or drained). A client that
      // stops reading stops accepting writes, so this stops advancing (#813).
      let lastProgressAt = Date.now();
      res.on("drain", () => {
        lastProgressAt = Date.now();
      });
      // Timers are collected here so `cleanup` can clear them without referencing
      // the heartbeat interval before it exists.
      const timers: NodeJS.Timeout[] = [];

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        for (const timer of timers) clearInterval(timer);
        unsubscribe?.();
        recordSseConnectionClosed();
        const remaining = (connectionsByClient.get(clientIp) ?? 1) - 1;
        if (remaining <= 0) connectionsByClient.delete(clientIp);
        else connectionsByClient.set(clientIp, remaining);
      };
      res.on("close", cleanup);

      const timeOut = (): void => {
        if (closed) return;
        recordSseConnectionTimedOut();
        logger.warn({ clientIp, taskId, staleTimeoutMs }, "closing stalled SSE stream");
        res.write(`event: stream_timeout\ndata: ${JSON.stringify({ type: "stream_timeout", taskId })}\n\n`);
        cleanup();
        res.end();
      };

      // Heartbeat doubles as the stall check: a successful keep-alive write
      // counts as progress, and no progress for `staleTimeoutMs` closes the stream.
      timers.push(
        setInterval(() => {
          if (closed) return;
          if (Date.now() - lastProgressAt > staleTimeoutMs) {
            timeOut();
            return;
          }
          if (res.write(": keep-alive\n\n")) lastProgressAt = Date.now();
        }, heartbeatMs),
      );

      let finished = false;
      const deliver = (event: StoredEvent): void => {
        if (closed || finished) return;
        // Backpressure (#813): past the high-water mark the client is not
        // reading, so the event is dropped and counted rather than letting the
        // socket buffer grow without bound.
        if (res.writableLength > highWaterMarkBytes) {
          recordSseEventDropped();
          return;
        }
        const wire = toWireEvent(event) as { type: string; seq: number };
        const flushed = res.write(
          `id: ${wire.seq}\nevent: ${wire.type}\ndata: ${JSON.stringify(wire)}\n\n`,
        );
        recordSseEventSent();
        if (flushed) lastProgressAt = Date.now();
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
