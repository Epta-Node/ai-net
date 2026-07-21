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
