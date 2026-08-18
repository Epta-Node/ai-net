import pino from 'pino';

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
