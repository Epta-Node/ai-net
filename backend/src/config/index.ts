import { z } from "zod";
// An import (not a bare require) makes tsc emit dist/package.json, so the same
// relative path resolves from both src/ and the compiled dist/src/.
import pkg from "../../package.json";

/**
 * Reject known placeholder values for secret-bearing configuration keys.
 * This prevents accidental deployment with placeholder values from .env.example.
 */
function rejectPlaceholder(value: string | undefined, ctx: z.RefinementCtx): void {
  // Optional keys are only checked when they are actually provided.
  if (value === undefined) return;

  const lowerValue = value.toLowerCase();
  const placeholderPatterns = [
    /^your_.*_here$/,
    /^test-.*$/,
    /^change-in-production$/,
    /^dev-.*$/,
    /^default-.*$/,
  ];

  for (const pattern of placeholderPatterns) {
    if (pattern.test(lowerValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Value "${value}" appears to be a placeholder. Please provide a real secret value.`,
      });
      return;
    }
  }
}

/**
 * Fallback secrets injected by `withRuntimeDefaults()`.
 *
 * These must not look like the placeholders rejected by `rejectPlaceholder()`
 * (in particular they must not start with `test-`/`dev-`), otherwise the very
 * defaults that make `NODE_ENV=test` and local development work would fail
 * schema validation.
 */
const TEST_FALLBACK_JWT_SECRET = "ai-net-jest-suite-jwt-secret-0123456789abcdef";
const DEV_FALLBACK_JWT_SECRET = "ai-net-local-development-jwt-secret-0123456789";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  STELLAR_NETWORK: z.enum(["testnet", "mainnet", "local", "futurenet"]).default("testnet"),
  STELLAR_HORIZON_URL: z.string().url().default("https://horizon-testnet.stellar.org"),
  STELLAR_HORIZON: z.string().url().optional(),
  STELLAR_PUBLIC_KEY: z.string().optional(),
  SKIP_STELLAR_ACCOUNT_VERIFY: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),
  SOROBAN_RPC_URL: z.string().url().default("https://soroban-testnet.stellar.org"),
  REGISTRY_CONTRACT_ID: z.string().optional(),

  VENICE_API_KEY: z.string().min(1, "VENICE_API_KEY is required"),
  VENICE_BASE_URL: z.string().url().default("https://api.venice.ai/api/v1"),
  VENICE_MODEL_VERSION: z.string().default("v1"),
  VENICE_CACHE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  VENICE_CACHE_CODING_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  VENICE_CACHE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  VENICE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  VENICE_PROVIDER_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  VENICE_FALLBACK_API_KEYS: z.string().optional(),
  VENICE_FALLBACK_BASE_URLS: z.string().optional(),
  /**
   * Cooldown applied to a Venice key whose recent error rate crosses
   * `VENICE_KEY_ERROR_RATE_THRESHOLD` (#806). `VENICE_API_KEY_1..10` are read
   * directly by the key pool, so they are not declared here.
   */
  VENICE_KEY_COOLDOWN_MS: z.coerce.number().int().positive().default(60_000),
  VENICE_KEY_ERROR_RATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.2),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required").default("./data/ai-net.db"),
  DB_MIGRATIONS_DIR: z.string().optional(),
  /** Apply pending schema migrations during server startup (Issue #274). */
  AUTO_MIGRATE: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("true"),
  STELLAR_COORDINATOR_SECRET: z.string().optional().superRefine(rejectPlaceholder),
  STELLAR_TEST_SECRET: z.string().optional().superRefine(rejectPlaceholder),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  NPM_PACKAGE_VERSION: z.string().default(pkg.version ?? "0.1.0"),
  GRACEFUL_SHUTDOWN_TIMEOUT: z.coerce.number().int().positive().default(30),
  HEALTH_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  /** Job queue depth at which `/health/deep` reports the queue as degraded. */
  HEALTH_QUEUE_DEPTH_WARN: z.coerce.number().int().positive().default(1_000),

  // ── Distributed tracing / OpenTelemetry export (issue #856) ────────────────
  /**
   * Fraction of spans sampled into in-memory traces, in `[0, 1]`. `1` records
   * every span, `0` records none — error spans (`status === 'failed'`) are
   * always recorded regardless of rate, so failures never disappear.
   */
  OTEL_SAMPLING_RATE: z.coerce.number().min(0).max(1).default(1),
  /**
   * When set, every ended span is exported as OTLP/HTTP JSON to
   * `${OTEL_EXPORTER_ENDPOINT}/v1/traces` (an OpenTelemetry Collector).
   * An empty value means "unset", matching the other optional keys.
   */
  OTEL_EXPORTER_ENDPOINT: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().optional(),
  ),

  CACHE_DRIVER: z.enum(["lru", "redis"]).default("lru"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  CACHE_LRU_MAX_SIZE: z.coerce.number().int().positive().default(500),
  CACHE_TTL_AGENTS: z.coerce.number().int().nonnegative().default(60),
  CACHE_TTL_STATS: z.coerce.number().int().nonnegative().default(30),
  CACHE_TTL_HEALTH: z.coerce.number().int().nonnegative().default(10),
  REGISTRY_CACHE_KEY_PREFIX: z.string().default("registry"),

  MAX_PROMPT_LENGTH: z.coerce.number().int().positive().default(10_000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(20),
  REGISTER_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_PUBLIC_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_PUBLIC_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_AUTHED_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_AUTHED_MAX_REQUESTS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_ADMIN_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_ADMIN_MAX_REQUESTS: z.coerce.number().int().positive().default(20),
  DAILY_TASK_LIMIT_PER_WALLET: z.coerce.number().int().min(0).default(100),

  // ── Per-wallet abuse-control quota (issue #803) ─────────────────────────────
  /**
   * Maximum task submissions a single wallet may have *accepted* in the
   * trailing 24 hours. The 51st submission is rejected with 429 QUOTA_EXCEEDED.
   * `0` disables the submission count check (token limits still apply).
   */
  MAX_DAILY_TASKS_PER_WALLET: z.coerce.number().int().min(0).default(50),
  /**
   * Maximum estimated Venice tokens a single wallet may consume in the
   * trailing 24 hours (approximated as `ceil(chars / 4)` at submit time).
   * `0` disables the token budget check.
   */
  MAX_DAILY_VENICE_TOKENS_PER_WALLET: z.coerce.number().int().min(0).default(100_000),
  /**
   * Hard prompt-length ceiling enforced by the quota layer before a request
   * reaches the handler. When unset, `MAX_PROMPT_LENGTH` is used so the quota
   * check and the legacy schema validation agree on one boundary.
   * (An empty value in `.env` means "unset", matching the other optional keys.)
   */
  MAX_PROMPT_CHARS_PER_REQUEST: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),

  TASK_TOKEN_BUDGET: z.coerce.number().int().positive().default(200_000),
  LLM_MAX_TOKENS_PER_CALL: z.coerce.number().int().positive().default(8_192),
  LLM_MAX_PROMPT_TOKENS: z.coerce.number().int().positive().default(16_000),
  VENICE_PRICING: z.string().optional(),
  COST_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Daily LLM spend budget in USD (#750): warn at 75%, refuse new work at 100%.
   * `0` disables the budget.
   */
  DAILY_COST_BUDGET_USD: z.coerce.number().min(0).default(0),

  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  HEARTBEAT_STALE_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(5),
  AGENT_OFFLINE_DELETE_HOURS: z.coerce.number().int().positive().default(24),

  /** Watchdog pass interval. Floor of 10s so a typo cannot turn the scan into a busy loop (#804). */
  AGENT_WATCHDOG_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  AGENT_WATCHDOG_GRACE_MINUTES: z.coerce.number().int().positive().default(10),

  RECONCILIATION_WEBHOOK_URL: z.string().url().optional(),
  RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  // ── Payment drift reconciliation (issue #496) ──────────────────────────────
  /**
   * Master switch for automatic drift remediation. When `false` a run only
   * *detects* drift and reports it; nothing is written to the payments table.
   */
  RECONCILIATION_REMEDIATION_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("true"),
  /**
   * How long a `locked` escrow may sit on-chain after its task reached a
   * terminal unsuccessful state before it is treated as expired and refunded.
   */
  RECONCILIATION_ESCROW_EXPIRY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(86_400_000),
  /** Maximum claimable balances pulled from Horizon in a single run. */
  RECONCILIATION_MAX_BALANCES: z.coerce.number().int().positive().default(2_000),
  /** Maximum release transactions verified against Horizon in a single run. */
  RECONCILIATION_MAX_TX_LOOKUPS: z.coerce.number().int().positive().default(200),

  // ── Drift alerting thresholds (issue #811) ──────────────────────────────────
  /** Amount drift (percent of the expected amount) that raises a `warning` alert. */
  RECONCILIATION_WARNING_DRIFT_PERCENT: z.coerce.number().nonnegative().default(1.0),
  /** Amount drift (percent of the expected amount) that raises a `critical` alert. */
  RECONCILIATION_CRITICAL_DRIFT_PERCENT: z.coerce.number().nonnegative().default(5.0),

  COMPRESSION_THRESHOLD: z.coerce.number().int().min(0).default(1024),
  COMPRESSION_LEVEL: z.coerce.number().int().min(1).max(9).default(6),
  COMPRESSION_ENABLE_BROTLI: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("true"),

  API_LATEST_VERSION: z.string().default("2.0"),
  API_SUPPORTED_VERSIONS: z.string().default("1.0,1.1,2.0"),
  API_DEFAULT_VERSION: z.string().default("1.0"),
  API_V1_SUNSET_DATE: z.string().optional(),

  ADMIN_API_KEY: z.string().min(1).optional(),
  API_KEYS: z.string().optional(),

  DB_POOL_MIN: z.coerce.number().int().positive().default(2),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_POOL_HEALTH_CHECK: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("true"),
  DB_BACKUP_DIR: z.string().default("./data/backups"),
  DB_BACKUP_RETENTION_COUNT: z.coerce.number().int().positive().default(5),
  /**
   * Passphrase for at-rest database backups (issue #747). Scrypt-derived into
   * an AES-256-GCM key; every backup is encrypted and paired with a checksum
   * manifest. When unset the backup pipeline fails closed rather than writing
   * plaintext — set it in every environment that takes backups.
   * (An empty value in `.env` means "unset", matching the other optional keys.)
   */
  DB_BACKUP_ENCRYPTION_KEY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(1).optional(),
  ),
  DB_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  DB_MAINTENANCE_VACUUM_THRESHOLD: z.coerce.number().int().nonnegative().default(100),
  ERROR_REGISTRY_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  ERROR_REGISTRY_CAP_PER_AGENT: z.coerce.number().int().positive().default(100),

  EVENT_STORE_PATH: z.string().default("./data/events.db"),
  EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  EVENT_COMPACTION_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  EVENT_COMPACTION_BATCH_TASKS: z.coerce.number().int().positive().default(50),
  EVENT_COMPACTION_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("true"),
  /**
   * Days an archived event stays in the SQLite archive table before its whole
   * UTC day moves to a cold file (issue #809).
   */
  EVENT_HOT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  /** Root directory for cold, gzip-compressed daily event archives (issue #809). */
  EVENT_ARCHIVE_DIR: z.string().default("./data/archive"),
  /** Days a daily cold archive is kept before it is purged (issue #809). */
  EVENT_COLD_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  // ── Idempotency store (Issue #657) ───────────────────────────────────────────
  /** How long completed idempotency keys are retained for replay. Default: 24 h. */
  IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  /**
   * How long an in-flight idempotency reservation is honoured before it is
   * treated as abandoned and the key becomes reusable. Kept short so a handler
   * that dies without releasing its slot does not block the key for a full day.
   */
  IDEMPOTENCY_PENDING_TTL_MS: z.coerce.number().int().positive().default(300_000),
  /** How often the background cleanup sweep runs to delete expired keys. Default: 5 min. */
  IDEMPOTENCY_CLEANUP_MS: z.coerce.number().int().positive().default(300_000),

  /** Express trusted proxy policy: none, a hop count, or trusted IP/CIDR ranges. */
  TRUST_PROXY: z
    .string()
    .trim()
    .default("none")
    .transform((value): boolean | number | string => {
      if (
        !value ||
        value.toLowerCase() === "none" ||
        value.toLowerCase() === "false"
      ) {
        return false;
      }
      if (/^\d+$/.test(value)) {
        const hopCount = Number(value);
        return Number.isSafeInteger(hopCount) ? hopCount : value;
      }
      return value;
    }),

  WS_MAX_CONNECTIONS_PER_CLIENT: z.coerce.number().int().positive().default(5),
  WS_MAX_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(100),
  WS_INACTIVITY_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  WS_PONG_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ── SSE task event stream (#751) ────────────────────────────────────────────
  SSE_MAX_CONNECTIONS_PER_CLIENT: z.coerce.number().int().positive().default(5),
  SSE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  /** Socket write-buffer size above which task events are dropped for a slow client (#813). */
  SSE_HIGH_WATER_MARK_BYTES: z.coerce.number().int().positive().default(65_536),
  /** Close a stream with `stream_timeout` after this long without a successful write (#813). */
  SSE_STALE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  METRICS_CACHE_TTL_MS: z.coerce.number().int().positive().default(5_000),
  METRICS_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  METRICS_MAX_SAMPLES: z.coerce.number().int().positive().default(1_000),

  // ── Authentication & Session Security ───────────────────────────────────────
  /** JWT secret key used to sign and verify access tokens. */
  AUTH_JWT_SECRET: z
    .string()
    .min(32, "AUTH_JWT_SECRET must be at least 32 characters")
    .superRefine(rejectPlaceholder),
  /** Access token validity in seconds. Default: 900 (15 min). */
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  AUTH_SESSION_MAX_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

  // ── Quality Scorer Configuration ─────────────────────────────────────────────
  /** Weight for completeness score in quality calculation. Default: 0.4 */
  QUALITY_WEIGHT_COMPLETENESS: z.coerce.number().min(0).max(1).default(0.4),
  /** Weight for relevance score in quality calculation. Default: 0.3 */
  QUALITY_WEIGHT_RELEVANCE: z.coerce.number().min(0).max(1).default(0.3),
  /** Weight for format score in quality calculation. Default: 0.3 */
  QUALITY_WEIGHT_FORMAT: z.coerce.number().min(0).max(1).default(0.3),
  /** Threshold for requiring manual review. Default: 60 */
  QUALITY_REVIEW_THRESHOLD: z.coerce.number().int().min(0).max(100).default(60),
  /** Enable percentile-based quality scoring. Default: false */
  QUALITY_PERCENTILE_ENABLED: z.enum(["true", "false"]).transform((v) => v === "true").default("false"),
  /** Minimum samples required for percentile calculation. Default: 10 */
  QUALITY_PERCENTILE_MIN_SAMPLES: z.coerce.number().int().positive().default(10),
  /** Cache quality scores by output content hash, skipping repeat scoring work. Default: true (#812) */
  QUALITY_SCORER_CACHE_ENABLED: z.enum(["true", "false"]).transform((v) => v === "true").default("true"),
  /** How long a cached quality score stays valid, in ms. Default: 1 hour (#812) */
  QUALITY_SCORER_CACHE_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** Maximum cached quality scores before LRU eviction. Default: 500 (#812) */
  QUALITY_SCORER_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(500),

  // ── Admin Control Configuration ─────────────────────────────────────────────
  /** Enable read-only mode for the API. Default: false */
  AI_NET_READ_ONLY: z.enum(["true", "false"]).transform((v) => v === "true").default("false"),
  /** Reason for read-only mode. Optional. */
  AI_NET_READ_ONLY_REASON: z.string().optional(),
  /** Path to admin audit database. Default: ./data/admin-audit.db */
  ADMIN_AUDIT_DB_PATH: z.string().default("./data/admin-audit.db"),
  /** Days to keep admin audit entries; older rows are pruned during maintenance runs. 0 disables pruning. */
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
  /** Directory for admin backups. Default: ./data/backups/admin */
  ADMIN_BACKUP_DIR: z.string().default("./data/backups/admin"),

  // ── Database observability (#807) ───────────────────────────────────────────
  /** Comma-separated query-latency histogram bounds in milliseconds. Default: 1,5,10,50,100,500,1000 */
  DB_LATENCY_BUCKETS: z.string().optional(),
  /** Statements at or above this duration are logged as `slow_query`. Default: 200 */
  SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().positive().default(200),

  // ── Agent ownership proof (#557, #558) ───────────────────────────────────────
  /**
   * Lifetime of a single-use agent auth challenge. Kept short because a
   * challenge is redeemed exactly once; 5 minutes covers clock skew.
   */
  AGENT_CHALLENGE_TTL_MS: z.coerce.number().int().positive().default(300_000),
  /** Failed *unsigned* agent-auth attempts tolerated per IP per window. */
  AGENT_AUTH_FAILURE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  /** Sliding window the failed unsigned agent-auth budget is measured over. */
  AGENT_AUTH_FAILURE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * ISO-8601 date the unsigned register/heartbeat path stops being tolerated.
   * Unset (the default) advertises no `Sunset` header yet.
   */
  AGENT_AUTH_SUNSET_DATE: z.string().optional(),

  // ── Feature flags (#425) ────────────────────────────────────────────────────
  /**
   * Overrides for the compiled-in defaults in `services/featureFlags.ts`, which
   * resolves them dynamically as `FEATURE_<FLAG_NAME>`. They must be declared
   * here so Zod does not strip them from the parsed config: a key that is not
   * in the schema can never be read back through `getConfig()`. Keep in sync
   * with `KNOWN_FLAGS`; an empty value means "use the compiled-in default".
   */
  FEATURE_STREAMING_RESPONSES: z.string().optional(),
  FEATURE_DAG_PREVIEW: z.string().optional(),
  FEATURE_EXPERIMENTAL_AGENTS: z.string().optional(),
  FEATURE_QUALITY_SCORER: z.string().optional(),
  FEATURE_RECONCILIATION: z.string().optional(),
  FEATURE_AGENT_OWNERSHIP_PROOF: z.string().optional(),

  // ── Job leases (#648) ───────────────────────────────────────────────────────
  /** How long a worker's claim on a job stays valid without a heartbeat. */
  JOB_LEASE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  /** How often a running job's lease is renewed — must be well inside the TTL. */
  JOB_LEASE_HEARTBEAT_MS: z.coerce.number().int().positive().default(10_000),

  // ── Job retry policy (#752) ─────────────────────────────────────────────────
  /** Base of the full-jitter exponential backoff between job retries, in ms. */
  JOB_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1_000),
  /** Ceiling for a single job retry delay, in ms. */
  JOB_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300_000),
  /** Attempts before a job is moved to the dead-letter queue. */
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
});

export type RawConfig = z.infer<typeof envSchema>;
export type Config = RawConfig & {
  STELLAR_NETWORK_PASSPHRASE: string;
};

export class ConfigValidationError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    super(
      `[config] Invalid environment variables:\n${issues
        .map((issue) => `  ${issue.path.join(".") || "ENV"}: ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "ConfigValidationError";
  }
}

let cachedConfig: Config | null = null;

function withRuntimeDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nodeEnv = env.NODE_ENV ?? "development";
  const dbUrl = env.DATABASE_URL ?? env.DB_PATH;
  const testDefaults =
    nodeEnv === "test"
      ? {
          DATABASE_URL: ":memory:",
          // Keep the event store off the filesystem under test, mirroring
          // DATABASE_URL. Tests that need real persistence pass an explicit
          // path to createEventStore() instead.
          EVENT_STORE_PATH: ":memory:",
          VENICE_API_KEY: "test-venice-key",
          // Deterministic key so backup round-trips are testable without ever
          // falling back to plaintext backups (issue #747 fails closed).
          DB_BACKUP_ENCRYPTION_KEY: "test-backup-encryption-key-0123456789",
          LOG_LEVEL: "silent",
          AUTH_JWT_SECRET: TEST_FALLBACK_JWT_SECRET,
        }
      : {};

  const devDefaults =
    nodeEnv === "development"
      ? {
          AUTH_JWT_SECRET: env.AUTH_JWT_SECRET ?? DEV_FALLBACK_JWT_SECRET,
        }
      : {};

  return {
    ...testDefaults,
    ...devDefaults,
    ...env,
    DATABASE_URL: dbUrl ?? testDefaults.DATABASE_URL ?? "./data/ai-net.db",
    STELLAR_HORIZON_URL: env.STELLAR_HORIZON_URL ?? env.STELLAR_HORIZON ?? "https://horizon-testnet.stellar.org",
  };
}

function networkPassphrase(network: RawConfig["STELLAR_NETWORK"]): string {
  switch (network) {
    case "mainnet":
      return "Public Global Stellar Network ; September 2015";
    case "local":
      return "Standalone Network ; February 2017";
    case "futurenet":
      return "Test SDF Future Network ; October 2022";
    case "testnet":
    default:
      return "Test SDF Network ; September 2015";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(withRuntimeDefaults(env));

  if (!result.success) {
    throw new ConfigValidationError(result.error.issues);
  }

  const nodeEnv = result.data.NODE_ENV;

  // Fail closed in production: AUTH_JWT_SECRET must be explicitly set
  if (nodeEnv === "production") {
    const providedSecret = env.AUTH_JWT_SECRET;
    if (!providedSecret) {
      throw new ConfigValidationError([
        {
          code: z.ZodIssueCode.custom,
          path: ["AUTH_JWT_SECRET"],
          message: "AUTH_JWT_SECRET is required in production",
        },
      ]);
    }
  }

  // Fail closed on CORS (#810). Origins are matched exactly, so a wildcard or
  // `null` entry can never match a real origin and only signals a
  // misconfiguration. Production must also name its origins explicitly rather
  // than silently inheriting the localhost default.
  const originEntries = result.data.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const invalidOrigin = originEntries.find((origin) => origin.includes("*") || origin === "null");
  if (invalidOrigin) {
    throw new ConfigValidationError([
      {
        code: z.ZodIssueCode.custom,
        path: ["ALLOWED_ORIGINS"],
        message: `ALLOWED_ORIGINS entry "${invalidOrigin}" is not allowed; list each origin explicitly (no wildcards, no "null")`,
      },
    ]);
  }
  if (nodeEnv === "production" && (!env.ALLOWED_ORIGINS?.trim() || originEntries.length === 0)) {
    throw new ConfigValidationError([
      {
        code: z.ZodIssueCode.custom,
        path: ["ALLOWED_ORIGINS"],
        message: "ALLOWED_ORIGINS is required in production and must list at least one origin",
      },
    ]);
  }

  // Warn in development if using default secret
  if (nodeEnv === "development") {
    const secret = result.data.AUTH_JWT_SECRET;
    if (secret === DEV_FALLBACK_JWT_SECRET) {
      console.warn(
        "[config] WARNING: Using default AUTH_JWT_SECRET in development. " +
          "Set AUTH_JWT_SECRET to a secure random value in production."
      );
    }
  }

  cachedConfig = {
    ...result.data,
    STELLAR_NETWORK_PASSPHRASE: networkPassphrase(result.data.STELLAR_NETWORK),
  };
  return cachedConfig;
}

export function getConfig(): Config {
  if (process.env.NODE_ENV === "test") {
    return loadConfig();
  }
  return cachedConfig ?? loadConfig();
}

export function resetConfigForTests(): void {
  cachedConfig = null;
}

export const config = new Proxy({} as Config, {
  get(_target, property: keyof Config) {
    return getConfig()[property];
  },
});

/**
 * Options for Horizon / Soroban RPC clients. The SDK rejects plain-http URLs
 * unless `allowHttp` is set; only the local standalone network (the docker
 * compose Stellar node) is served over http, so nothing else may skip TLS.
 */
export function stellarClientOptions(cfg: Config = getConfig()): { allowHttp: boolean } {
  return { allowHttp: cfg.STELLAR_NETWORK === "local" };
}

export function ttlForRoute(group: "agents" | "stats" | "health"): number {
  const cfg = getConfig();
  switch (group) {
    case "agents":
      return cfg.CACHE_TTL_AGENTS;
    case "stats":
      return cfg.CACHE_TTL_STATS;
    case "health":
      return cfg.CACHE_TTL_HEALTH;
  }
}

export function allowedOrigins(): string[] {
  return getConfig()
    .ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function redactConfigValue(key: string, value: unknown): unknown {
  if (/secret|token|api[_-]?key|password|authorization|cookie|private[_-]?key/i.test(key)) {
    return value ? "[REDACTED]" : value;
  }
  if (/address|public[_-]?key|wallet|owner|claimant|destination|source/i.test(key)) {
    return value ? "[REDACTED_ADDRESS]" : value;
  }
  return value;
}

export function redactedConfigSnapshot(cfg: Config = getConfig()): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(cfg).map(([key, value]) => [key, redactConfigValue(key, value)]),
  );
}

export { envSchema };