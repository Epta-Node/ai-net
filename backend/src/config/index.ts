import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../../package.json");

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  STELLAR_NETWORK: z.enum(["testnet", "mainnet", "local", "futurenet"]).default("testnet"),
  STELLAR_HORIZON_URL: z.string().url().default("https://horizon-testnet.stellar.org"),
  VENICE_API_KEY: z.string().min(1, "VENICE_API_KEY is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  STELLAR_COORDINATOR_SECRET: z.string().optional(),
  STELLAR_TEST_SECRET: z.string().optional(),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  NPM_PACKAGE_VERSION: z.string().default(pkg.version ?? "0.1.0"),
  GRACEFUL_SHUTDOWN_TIMEOUT: z.coerce.number().int().positive().default(30),

  // ── Input validation ────────────────────────────────────────────────────────
  /** Maximum allowed length (characters) for a task prompt. Default: 10 000. */
  MAX_PROMPT_LENGTH: z.coerce.number().int().positive().default(10_000),

  // ── Rate limiting ───────────────────────────────────────────────────────────
  /** Rolling window in milliseconds for the tasks rate limiter. Default: 60 000 (1 min). */
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** Max task-creation requests per IP per window. Default: 20. */
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(20),
  /** Max agent-registration requests per IP per window. Default: 10. */
  REGISTER_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),

  // ── Per-wallet quotas ───────────────────────────────────────────────────────
  /** Maximum tasks a single wallet may create within a rolling 24-hour window.
   *  Set to 0 to disable the daily quota. Default: 100. */
  DAILY_TASK_LIMIT_PER_WALLET: z.coerce.number().int().min(0).default(100),

  // ── Heartbeat & Agent Cleanup ───────────────────────────────────────────────
  /** Background cleanup interval in milliseconds. Default: 300 000 (5 min). */
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  /** Minutes without a heartbeat before an agent is marked offline. Default: 5. */
  HEARTBEAT_STALE_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(5),
  /** Hours an offline agent is kept before permanent cleanup. Default: 24. */
  AGENT_OFFLINE_DELETE_HOURS: z.coerce.number().int().positive().default(24),

  // ── Payment reconciliation ──────────────────────────────────────────────────
  /** Optional webhook URL that receives reconciliation discrepancy alerts. */
  RECONCILIATION_WEBHOOK_URL: z.string().url().optional(),
  /** Automated reconciliation interval in milliseconds. Default: 86 400 000 (daily). */
  RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),

  // ── Response Compression ────────────────────────────────────────────────────
  /** Minimum response size in bytes before compression is applied. Default: 1024 (1 KB). */
  COMPRESSION_THRESHOLD: z.coerce.number().int().min(0).default(1024),
  /** gzip compression level 1–9. Lower = faster, higher = smaller. Default: 6. */
  COMPRESSION_LEVEL: z.coerce.number().int().min(1).max(9).default(6),
  /** Enable Brotli compression when the client sends Accept-Encoding: br. Default: true. */
  COMPRESSION_ENABLE_BROTLI: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("true"),

  // ── API Versioning ──────────────────────────────────────────────────────────
  /** Latest API version. Default: "2.0". */
  API_LATEST_VERSION: z.string().default("2.0"),
  /** Supported API versions (comma-separated). Default: "1.0,1.1,2.0". */
  API_SUPPORTED_VERSIONS: z.string().default("1.0,1.1,2.0"),
  /** Default API version when no header is provided. Default: "1.0" for backward compatibility. */
  API_DEFAULT_VERSION: z.string().default("1.0"),
  /** Sunset date for deprecated API versions (ISO 8601 format). Optional. */
  API_V1_SUNSET_DATE: z.string().optional(),

  // ── Admin API ───────────────────────────────────────────────────────────────
  /**
   * Shared secret required by admin-only endpoints such as
   * `GET /health/dashboard`. Sent as `X-Admin-API-Key: <key>` or
   * `Authorization: Bearer <key>`. When unset, those endpoints refuse every
   * request with 503 rather than falling open.
   */
  ADMIN_API_KEY: z.string().min(1).optional(),

  // ── WebSocket Stream ────────────────────────────────────────────────────────
  /** Maximum concurrent WebSocket connections per client IP. Default: 5. */
  WS_MAX_CONNECTIONS_PER_CLIENT: z.coerce.number().int().positive().default(5),
  /** Maximum messages per minute per WebSocket connection. Default: 100. */
  WS_MAX_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(100),
  /** Auto-disconnect after N ms of inactivity. Default: 1800000 (30 min). */
  WS_INACTIVITY_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  /** Heartbeat ping interval in ms. Default: 30000 (30 s). */
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Pong timeout before marking connection stale. Default: 10000 (10 s). */
  WS_PONG_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ── Health dashboard metrics ────────────────────────────────────────────────
  /** How long a dashboard snapshot is served before recollection. Default: 5 000 (5 s). */
  METRICS_CACHE_TTL_MS: z.coerce.number().int().positive().default(5_000),
  /** Rolling window used for request rate/latency/error analytics. Default: 60 000 (1 min). */
  METRICS_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** Maximum request samples retained in memory. Default: 1 000. */
  METRICS_MAX_SAMPLES: z.coerce.number().int().positive().default(1_000),
});


let _config: z.infer<typeof envSchema> | null = null;

export function loadConfig(): z.infer<typeof envSchema> {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n  ");
    console.error(`[config] Environment validation failed:\n  ${missing}`);
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): z.infer<typeof envSchema> {
  if (!_config) throw new Error("Config not loaded. Call loadConfig() first.");
  return _config;
}
