/**
 * Pool sizing shared by every database module.
 *
 * Read lazily rather than at import time: `loadConfig()` is called from the
 * server entrypoint, but unit tests import database modules directly without
 * an environment, and must still get working defaults.
 */

import {
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MIN_CONNECTIONS,
  type PoolOptions,
} from "./pool";

/** Pool settings from the environment, falling back to the built-in defaults. */
export function poolSettings(): Pick<
  PoolOptions,
  "min" | "max" | "acquireTimeoutMs" | "healthCheck"
> {
  try {
    // Imported lazily so a missing environment cannot break module loading.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getConfig } = require("../config") as typeof import("../config");
    const config = getConfig();
    return {
      min: config.DB_POOL_MIN,
      max: config.DB_POOL_MAX,
      acquireTimeoutMs: config.DB_POOL_ACQUIRE_TIMEOUT_MS,
      healthCheck: config.DB_POOL_HEALTH_CHECK,
    };
  } catch {
    // Config not loaded (unit tests, scripts): use the documented defaults.
    return {
      min: DEFAULT_MIN_CONNECTIONS,
      max: DEFAULT_MAX_CONNECTIONS,
      acquireTimeoutMs: DEFAULT_ACQUIRE_TIMEOUT_MS,
      healthCheck: true,
    };
  }
}
