import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../../package.json");

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  STELLAR_NETWORK: z.enum(["testnet", "mainnet", "local", "futurenet"]).default("testnet"),
  STELLAR_HORIZON_URL: z.string().url().default("https://horizon-testnet.stellar.org"),
  VENICE_API_KEY: z.string().min(1, "VENICE_API_KEY is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required").default("./data/ai-net.db"),
  STELLAR_COORDINATOR_SECRET: z.string().optional(),
  STELLAR_TEST_SECRET: z.string().optional(),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  NPM_PACKAGE_VERSION: z.string().default(pkg.version ?? "0.1.0"),
  GRACEFUL_SHUTDOWN_TIMEOUT: z.coerce.number().int().positive().default(30),

  CACHE_DRIVER: z.enum(["lru", "redis"]).default("lru"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  CACHE_LRU_MAX_SIZE: z.coerce.number().int().positive().default(500),
  CACHE_TTL_AGENTS: z.coerce.number().int().nonnegative().default(60),
  CACHE_TTL_STATS: z.coerce.number().int().nonnegative().default(30),
  CACHE_TTL_HEALTH: z.coerce.number().int().nonnegative().default(10),

  MAX_PROMPT_LENGTH: z.coerce.number().int().positive().default(10_000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(20),
  REGISTER_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  DAILY_TASK_LIMIT_PER_WALLET: z.coerce.number().int().min(0).default(100),

  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  HEARTBEAT_STALE_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(5),
  AGENT_OFFLINE_DELETE_HOURS: z.coerce.number().int().positive().default(24),

  RECONCILIATION_WEBHOOK_URL: z.string().url().optional(),
  RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),

  COMPRESSION_THRESHOLD: z.coerce.number().int().min(0).default(1024),
  COMPRESSION_LEVEL: z.coerce.number().int().min(1).max(9).default(6),
  COMPRESSION_ENABLE_BROTLI: z.enum(["true", "false"]).transform((v) => v === "true").default("true"),

  API_LATEST_VERSION: z.string().default("2.0"),
  API_SUPPORTED_VERSIONS: z.string().default("1.0,1.1,2.0"),
  API_DEFAULT_VERSION: z.string().default("1.0"),
  API_V1_SUNSET_DATE: z.string().optional(),

  ADMIN_API_KEY: z.string().min(1).optional(),

  WS_MAX_CONNECTIONS_PER_CLIENT: z.coerce.number().int().positive().default(5),
  WS_MAX_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(100),
  WS_INACTIVITY_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  WS_PONG_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  METRICS_CACHE_TTL_MS: z.coerce.number().int().positive().default(5_000),
  METRICS_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
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

export type Config = z.infer<typeof envSchema>;

export const config = loadConfig();

export function ttlForRoute(group: "agents" | "stats" | "health"): number {
  switch (group) {
    case "agents":
      return config.CACHE_TTL_AGENTS;
    case "stats":
      return config.CACHE_TTL_STATS;
    case "health":
      return config.CACHE_TTL_HEALTH;
    default:
      return config.CACHE_TTL_HEALTH;
  }
}

