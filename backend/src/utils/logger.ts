import crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import pino from "pino";
import type { DestinationStream, Logger } from "pino";
import { getConfig } from "../config";
import { currentTraceContext } from '../services/traceContext';

const REDACTED = "[REDACTED]";
const REDACTED_ADDRESS = "[REDACTED_ADDRESS]";
const REDACTED_BODY = "[REDACTED_BODY]";
/** Maximum length for a single log field value before it is truncated. */
export const MAX_LOG_FIELD_LEN = 500;
const DEFAULT_LOG_CONTEXT = {
  requestId: "system",
  traceId: "system",
  userId: "system",
  taskId: "none",
  route: "system",
};
const logContextStore = new AsyncLocalStorage<Record<string, unknown>>();

const SECRET_KEY_RE =
  /secret|token|api[_-]?key|password|authorization|cookie|private[_-]?key|seed|signature|jwt|credential/i;
// Prompt / LLM and HTTP payload bodies (Issue #746): logged by mistake they
// leak user content and anything pasted into it, so they are never written.
const BODY_KEY_RE =
  /^(prompt|completion|body|req[_-]?body|res[_-]?body|request[_-]?body|response[_-]?body)$/i;
const ADDRESS_KEY_RE =
  /address|public[_-]?key|wallet|owner|claimant|destination|source|account/i;
const STELLAR_ADDRESS_RE = /\b[CGM][A-Z2-7]{55}\b/g;
const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE_SECRET_RE =
  /\b(api[_-]?key|token|secret|password|authorization)=([^\s"',}]+)/gi;

export interface LoggerFactoryOptions {
  destination?: DestinationStream;
}

function redactString(value: string): string {
  return value
    .replace(STELLAR_SECRET_RE, REDACTED)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(KEY_VALUE_SECRET_RE, (_match, key) => `${key}=${REDACTED}`)
    .replace(STELLAR_ADDRESS_RE, REDACTED_ADDRESS);
}

function truncateField(value: string): string {
  if (value.length > MAX_LOG_FIELD_LEN) {
    return `${value.slice(0, MAX_LOG_FIELD_LEN)}...`;
  }
  return value;
}

function redactByKey(key: string | undefined, value: unknown): unknown {
  if (!key) return value;
  if (SECRET_KEY_RE.test(key)) {
    return value ? REDACTED : value;
  }
  if (BODY_KEY_RE.test(key)) {
    return value ? REDACTED_BODY : value;
  }
  if (ADDRESS_KEY_RE.test(key)) {
    if (typeof value === "string") return redactString(value) === value ? REDACTED_ADDRESS : redactString(value);
    return value ? REDACTED_ADDRESS : value;
  }
  return value;
}

function serializeError(error: Error): Record<string, unknown> {
  const maybeCoded = error as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    details?: unknown;
  };

  return sanitizeLogPayload({
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: maybeCoded.code,
    status: maybeCoded.status,
    statusCode: maybeCoded.statusCode,
    details: maybeCoded.details,
  }) as Record<string, unknown>;
}

export function sanitizeLogPayload(
  value: unknown,
  key?: string,
  seen = new WeakSet<object>(),
): unknown {
  const keyed = redactByKey(key, value);
  if (keyed !== value) return keyed;
  // Whitelist req/res up front so a full Express object is never walked.
  if ((key === "req" || key === "res") && typeof value === "object" && value !== null) {
    return sanitizeLogPayload(logSerializers[key](value as never), undefined, seen);
  }

  if (typeof value === "string") return truncateField(redactString(value));
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Error) return serializeError(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLogPayload(entry, key, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    output[childKey] = sanitizeLogPayload(childValue, childKey, seen);
  }
  return output;
}

/**
 * Whitelisting serializers for `{ req }` / `{ res }` log fields (Issue #746).
 * Only the listed fields are ever emitted; headers, bodies and query strings
 * are dropped instead of relying on the blacklist above to catch them.
 */
export const logSerializers = {
  req(req: { method?: string; url?: string; originalUrl?: string; id?: unknown; ip?: string }) {
    const url = req.originalUrl ?? req.url;
    return {
      id: req.id,
      method: req.method,
      path: typeof url === "string" ? url.split("?")[0] : undefined,
      ip: req.ip,
    };
  },
  res(res: { statusCode?: number }) {
    return { statusCode: res.statusCode };
  },
};

export function hashLogIdentifier(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeBindings(bindings?: Record<string, unknown>): Record<string, unknown> {
  const sanitized = (sanitizeLogPayload(bindings ?? {}) ?? {}) as Record<string, unknown>;
  const traceId = sanitized.traceId ?? sanitized.correlationId ?? DEFAULT_LOG_CONTEXT.traceId;

  return {
    ...DEFAULT_LOG_CONTEXT,
    ...sanitized,
    traceId,
    requestId: sanitized.requestId ?? DEFAULT_LOG_CONTEXT.requestId,
  };
}

export function runWithLogContext<T>(context: Record<string, unknown>, callback: () => T): T {
  return logContextStore.run(normalizeBindings(context), callback);
}

export function updateLogContext(context: Record<string, unknown>): void {
  const store = logContextStore.getStore();
  if (!store) return;
  Object.assign(store, normalizeBindings({ ...store, ...context }));
}

export function getLogContext(): Record<string, unknown> {
  return logContextStore.getStore() ?? DEFAULT_LOG_CONTEXT;
}

function createBaseLogger(destination?: DestinationStream): Logger {
  let level: pino.LevelWithSilent = "info";
  try {
    level = getConfig().LOG_LEVEL;
  } catch {
    // Startup calls loadConfig() explicitly and reports schema issues.
  }
  const options: pino.LoggerOptions = {
    level,
    enabled: level !== "silent",
    base: DEFAULT_LOG_CONTEXT,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: logSerializers,
    // Hide sensitive fields at the serializer level (Issue #494) before the
    // custom recursive sanitizer runs. This covers keys nested at any depth.
    redact: {
      censor: REDACTED,
      paths: [
        '*.apiKey',
        '*.secret',
        '*.password',
        '*.token',
        '*.authorization',
        '*.privateKey',
        '*.seed',
        '*.cookie',
        '*.api_key',
        '*.secretKey',
        '*.signature',
        '*.jwt',
        '*.veniceApiKey',
        '*.headers.authorization',
        '*.headers.cookie',
        '*.headers["x-api-key"]',
        '*.headers["set-cookie"]',
        '*.prompt',
        '*.completion',
      ],
    },
    // Auto-inject traceId / spanId / parentSpanId from the active
    // AsyncLocalStorage trace context (Issue #407 / #494) so every log line in
    // a traced flow carries the correlation IDs without the caller having to
    // pass them explicitly.
    mixin() {
      const ctx = currentTraceContext();
      if (!ctx) return {};
      const bindings: Record<string, unknown> = { traceId: ctx.traceId, spanId: ctx.spanId };
      if (ctx.taskId) bindings.taskId = ctx.taskId;
      if (ctx.requestId) bindings.requestId = ctx.requestId;
      if (ctx.parentSpanId) bindings.parentSpanId = ctx.parentSpanId;
      return bindings;
    },
    hooks: {
      logMethod(inputArgs, method) {
        const currentLogger = this as Logger & {
          bindings?: () => Record<string, unknown>;
        };
        const loggerBindings =
          typeof currentLogger.bindings === "function" ? currentLogger.bindings() : {};
        const activeContext = logContextStore.getStore();
        const context = normalizeBindings(
          activeContext ? { ...loggerBindings, ...activeContext } : loggerBindings,
        );
        const sanitizedArgs = inputArgs.map((arg) => sanitizeLogPayload(arg));
        const first = sanitizedArgs[0];
        if (
          first &&
          typeof first === "object" &&
          !Array.isArray(first) &&
          !(first instanceof Error)
        ) {
          sanitizedArgs[0] = { ...context, ...(first as Record<string, unknown>) };
        } else {
          sanitizedArgs.unshift(context);
        }
        return method.apply(this, sanitizedArgs as any);
      },
    },
  };

  const instance = destination ? pino(options, destination) : pino(options);
  // Child bindings are serialized once at `.child()` time and skip both
  // logMethod and formatters.bindings, so a secret bound there would be
  // written verbatim on every line (#746). Children inherit this override
  // through pino's prototype chain, so grandchildren are covered too.
  const pinoChild = instance.child;
  instance.child = function child(this: Logger, bindings, childOptions) {
    return pinoChild.call(
      this,
      sanitizeLogPayload(bindings) as Record<string, unknown>,
      childOptions,
    );
  } as typeof instance.child;
  return instance;
}

let baseLogger: Logger | null = null;

export function createLogger(
  bindings?: Record<string, unknown>,
  options: LoggerFactoryOptions = {},
): Logger {
  const root = options.destination ? createBaseLogger(options.destination) : baseLogger ?? createBaseLogger();
  if (!options.destination && !baseLogger) {
    baseLogger = root;
  }
  return root.child(normalizeBindings(bindings));
}

const logger = createLogger();

export default logger;
