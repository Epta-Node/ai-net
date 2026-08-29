import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../../package.json");

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const requiredString = (name: string) => z.string().trim().min(1, `${name} is required`);

const boolFromEnv = z
  .preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return value;
  }, z.boolean())
  .default(false);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NPM_PACKAGE_VERSION: z.string().default(pkg.version ?? "0.1.0"),
  GRACEFUL_SHUTDOWN_TIMEOUT: z.coerce.number().int().positive().default(30),

  DATABASE_URL: requiredString("DATABASE_URL").default("./data/ai-net.db"),

  ALLOWED_ORIGINS: z.string().trim().min(1).default("http://localhost:3000"),
  API_KEYS: optionalString,
  ADMIN_API_KEY: optionalString,

  STELLAR_NETWORK: z
    .enum(["testnet", "mainnet", "local", "futurenet"])
    .default("testnet"),
  STELLAR_HORIZON_URL: z.string().url().default("https://horizon-testnet.stellar.org"),
  STELLAR_HORIZON: optionalString,
  STELLAR_COORDINATOR_SECRET: optionalString,
  STELLAR_TEST_SECRET: optionalString,
  STELLAR_PUBLIC_KEY: optionalString,
  SOROBAN_RPC_URL: z.string().url().default("https://soroban-testnet.stellar.org"),
  REGISTRY_CONTRACT_ID: optionalString,
  SKIP_STELLAR_ACCOUNT_VERIFY: boolFromEnv,

  VENICE_API_KEY: requiredString("VENICE_API_KEY"),
  VENICE_BASE_URL: z.string().url().default("https://api.venice.ai/api/v1"),
  VENICE_MODEL_VERSION: z.string().min(1).default("v1"),
  VENICE_CACHE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  VENICE_CACHE_CODING_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  VENICE_CACHE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),

  CACHE_DRIVER: z.enum(["lru", "redis"]).default("lru"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  CACHE_LRU_MAX_SIZE: z.coerce.number().int().positive().default(500),
  CACHE_TTL_AGENTS: z.coerce.number().int().nonnegative().default(60),
  CACHE_TTL_STATS: z.coerce.number().int().nonnegative().default(30),
  CACHE_TTL_HEALTH: z.coerce.number().int().nonnegative().default(10),

  MAX_PROMPT_LENGTH: z.coerce.number().int().positive().default(10_000),
  DAILY_TASK_LIMIT_PER_WALLET: z.coerce.number().int().min(0).default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(20),
  REGISTER_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),

  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  HEARTBEAT_STALE_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(5),
  AGENT_OFFLINE_DELETE_HOURS: z.coerce.number().int().positive().default(24),

  RECONCILIATION_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),

  COMPRESSION_THRESHOLD: z.coerce.number().int().min(0).default(1024),
  COMPRESSION_LEVEL: z.coerce.number().int().min(1).max(9).default(6),
  COMPRESSION_ENABLE_BROTLI: z
    .preprocess((value) => {
      if (typeof value === "boolean") return value;
      if (typeof value !== "string") return value;
      return value.trim().toLowerCase() === "true";
    }, z.boolean())
    .default(true),

  API_LATEST_VERSION: z.string().default("2.0"),
  API_SUPPORTED_VERSIONS: z.string().default("1.0,1.1,2.0"),
  API_DEFAULT_VERSION: z.string().default("1.0"),
  API_V1_SUNSET_DATE: optionalString,

  WS_MAX_CONNECTIONS_PER_CLIENT: z.coerce.number().int().positive().default(5),
  WS_MAX_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(100),
  WS_INACTIVITY_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  WS_PONG_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  METRICS_CACHE_TTL_MS: z.coerce.number().int().positive().default(5_000),
  METRICS_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  METRICS_MAX_SAMPLES: z.coerce.number().int().positive().default(1_000),
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
  const testDefaults =
    nodeEnv === "test"
      ? {
          DATABASE_URL: ":memory:",
          VENICE_API_KEY: "test-venice-key",
          LOG_LEVEL: "silent",
        }
      : {};

  return {
    ...testDefaults,
    ...env,
    STELLAR_HORIZON_URL: env.STELLAR_HORIZON_URL ?? env.STELLAR_HORIZON,
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

  cachedConfig = {
    ...result.data,
    STELLAR_NETWORK_PASSPHRASE: networkPassphrase(result.data.STELLAR_NETWORK),
  };
  return cachedConfig;
}

export function getConfig(): Config {
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
