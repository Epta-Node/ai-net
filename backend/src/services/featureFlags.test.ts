import {
  isEnabled,
  setFlag,
  getAllFlags,
  clearRuntimeOverrides,
  KNOWN_FLAGS,
} from "./featureFlags";

/** Environment variables this suite drives; saved and restored per test. */
const MANAGED_ENV_VARS = ["FEATURE_DAG_PREVIEW", "FEATURE_EXPERIMENTAL_AGENTS"] as const;

const savedEnv = new Map<string, string | undefined>();

const originalEnv = { ...process.env };
beforeEach(() => {
  for (const key of MANAGED_ENV_VARS) {
    savedEnv.set(key, process.env[key]);
  }
  clearRuntimeOverrides();
  process.env = { ...originalEnv };
});

afterEach(() => {
  for (const key of MANAGED_ENV_VARS) {
    const previous = savedEnv.get(key);
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  clearRuntimeOverrides();
  process.env = { ...originalEnv };
});

describe("isEnabled", () => {
  it("returns the compiled default when no override or env var is set", () => {
    // streaming_responses defaults to true
    expect(isEnabled("streaming_responses")).toBe(true);
    // dag_preview defaults to false
    expect(isEnabled("dag_preview")).toBe(false);
  });

  it("runtime override takes precedence over default", () => {
    setFlag("dag_preview", true);
    expect(isEnabled("dag_preview")).toBe(true);
  });

  it("env var overrides default but not runtime", () => {
    process.env.FEATURE_DAG_PREVIEW = "true";
    expect(isEnabled("dag_preview")).toBe(true);

    setFlag("dag_preview", false);
    expect(isEnabled("dag_preview")).toBe(false);
  });

  it("accepts '1' as truthy env value", () => {
    process.env.FEATURE_EXPERIMENTAL_AGENTS = "1";
    expect(isEnabled("experimental_agents")).toBe(true);
  });
});

describe("setFlag", () => {
  it("sets a runtime override", () => {
    setFlag("quality_scorer", false);
    expect(isEnabled("quality_scorer")).toBe(false);
  });

  it("clears a runtime override when passed null", () => {
    setFlag("streaming_responses", false);
    expect(isEnabled("streaming_responses")).toBe(false);

    setFlag("streaming_responses", null);
    expect(isEnabled("streaming_responses")).toBe(true);
  });
});

describe("getAllFlags", () => {
  it("returns an entry for every known flag", () => {
    const flags = getAllFlags();
    for (const flag of KNOWN_FLAGS) {
      expect(flags[flag]).toBeDefined();
      expect(typeof flags[flag].enabled).toBe("boolean");
      expect(["runtime", "env", "default"]).toContain(flags[flag].source);
    }
  });

  it("marks runtime-overridden flags with source=runtime", () => {
    setFlag("dag_preview", true);
    const flags = getAllFlags();
    expect(flags.dag_preview.source).toBe("runtime");
    expect(flags.dag_preview.enabled).toBe(true);
  });

  it("marks env-driven flags with source=env", () => {
    process.env.FEATURE_EXPERIMENTAL_AGENTS = "true";
    const flags = getAllFlags();
    expect(flags.experimental_agents.source).toBe("env");
  });
});
