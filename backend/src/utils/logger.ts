import pino from 'pino';

const isDevelopment = process.env.NODE_ENV === 'development';
const logLevel = process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info');

const baseLogger = pino({
  level: logLevel,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      '*.password',
      '*.apiKey',
      '*.token',
      '*.secret',
      'body.password',
      'body.token',
      'body.apiKey'
    ],
    censor: '[REDACTED]'
  },
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname'
        }
      }
    : undefined
});

/**
 * Create a child logger with bound fields.
 */
export function createLogger(bindings?: Record<string, unknown>): pino.Logger {
  return bindings ? baseLogger.child(bindings) : baseLogger;
}

/** Singleton root logger */
const logger = createLogger();

export default logger;
