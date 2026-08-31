import pino from 'pino';
import { currentTraceContext } from '../services/traceContext';

const level = process.env.LOG_LEVEL || 'info';

const baseLogger = pino({
  level,
  ...(level === 'silent' ? { enabled: false } : {}),
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Auto-inject traceId / spanId from the active AsyncLocalStorage context
  // so every log line in a traced flow carries the correlation IDs without
  // the caller having to pass them explicitly.
  mixin() {
    const ctx = currentTraceContext();
    if (!ctx) return {};
    const bindings: Record<string, unknown> = { traceId: ctx.traceId, spanId: ctx.spanId };
    if (ctx.taskId) bindings.taskId = ctx.taskId;
    if (ctx.requestId) bindings.requestId = ctx.requestId;
    return bindings;
  },
});

/**
 * Create a child logger with bound fields.
 *
 * @example
 *   const log = createLogger({ requestId: 'abc' });
 *   log.info({ taskId: 'task_xxx' }, 'node started');
 */
export function createLogger(bindings?: Record<string, unknown>): pino.Logger {
  return bindings ? baseLogger.child(bindings) : baseLogger;
}

/** Singleton root logger – use `createLogger` for child loggers with bound context. */
const logger = createLogger();

export default logger;
