import { getConfig } from "../config";

export type VeniceCapability = "general" | "research" | "coding" | "design" | "risk" | "report" | string;

export interface ModelConfig {
  id: string;
  capability: VeniceCapability[];
  costPerTokenUsd: number;
  /** Relative tier for fallback ordering; higher = more expensive/premium. */
  tier: number;
}

export interface ModelCallRecord {
  at: number;
  latencyMs: number;
  ok: boolean;
}

export interface ModelHealth {
  successRate: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
}

interface CircuitState {
  openUntil: number;
  belowThresholdSince: number | null;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWO_MINUTES_MS = 2 * 60 * 1000;
const CIRCUIT_OPEN_MS = 5 * 60 * 1000;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function defaultMaxInferenceCostUsd(): number {
  const raw = process.env.MAX_INFERENCE_COST_USD;
  if (raw === undefined || raw === "") {
    try {
      return (getConfig() as any).MAX_INFERENCE_COST_USD ?? 0.05;
    } catch {
      return 0.05;
    }
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0.05;
}

/**
 * Static model registry. Costs are USD per token.
 */
export const VENICE_MODEL_REGISTRY: readonly ModelConfig[] = [
  { id: "venice-mistral-7b", capability: ["general", "research", "risk", "design", "report"], costPerTokenUsd: 0.0003, tier: 1 },
  { id: "venice-code", capability: ["coding"], costPerTokenUsd: 0.0005, tier: 2 },
  { id: "venice-llama-70b", capability: ["general", "research", "risk", "design", "report"], costPerTokenUsd: 0.001, tier: 3 },
  { id: "venice-llama-405b", capability: ["general", "research", "risk", "design", "report", "coding", "premium"], costPerTokenUsd: 0.004, tier: 4 },
];

export class VeniceRouter {
  private readonly registry: readonly ModelConfig[];
  private readonly records = new Map<string, ModelCallRecord[]>();
  private readonly circuits = new Map<string, CircuitState>();
  private readonly now: () => number;

  constructor(options?: { registry?: readonly ModelConfig[]; now?: () => number }) {
    this.registry = options?.registry ?? VENICE_MODEL_REGISTRY;
    this.now = options?.now ?? (() => Date.now());
  }

  private getCircuit(model: string): CircuitState {
    let state = this.circuits.get(model);
    if (!state) {
      state = { openUntil: 0, belowThresholdSince: null };
      this.circuits.set(model, state);
    }
    return state;
  }

  private prune(model: string, now: number): ModelCallRecord[] {
    const cutoff = now - FIVE_MINUTES_MS;
    const kept = (this.records.get(model) ?? []).filter((r) => r.at >= cutoff);
    this.records.set(model, kept);
    return kept;
  }

  getModelHealth(model: string): ModelHealth {
    const now = this.now();
    const window = this.prune(model, now);
    if (window.length === 0) {
      return { successRate: 1, p50LatencyMs: 0, p99LatencyMs: 0 };
    }
    const ok = window.filter((r) => r.ok).length;
    const latencies = window.map((r) => r.latencyMs);
    return {
      successRate: ok / window.length,
      p50LatencyMs: percentile(latencies, 50),
      p99LatencyMs: percentile(latencies, 99),
    };
  }

  private isCircuitOpen(model: string, now: number): boolean {
    const circuit = this.getCircuit(model);
    return circuit.openUntil > now;
  }

  private updateCircuit(model: string, now: number): void {
    const health = this.getModelHealth(model);
    const circuit = this.getCircuit(model);

    if (health.successRate < 0.5) {
      if (circuit.belowThresholdSince === null) circuit.belowThresholdSince = now;
      if (now - circuit.belowThresholdSince >= TWO_MINUTES_MS) {
        circuit.openUntil = Math.max(circuit.openUntil, now + CIRCUIT_OPEN_MS);
      }
    } else {
      circuit.belowThresholdSince = null;
    }

    // Close naturally after openUntil passes; no action needed.
  }

  recordCall(model: string, latencyMs: number, ok: boolean): void {
    const now = this.now();
    const list = this.records.get(model) ?? [];
    list.push({ at: now, latencyMs: Math.max(0, latencyMs), ok });
    this.records.set(model, list);
    this.prune(model, now);
    this.updateCircuit(model, now);
  }

  selectModel(capability: VeniceCapability, promptTokenEstimate: number): ModelConfig {
    const now = this.now();
    const maxCost = defaultMaxInferenceCostUsd();
    const capable = this.registry
      .filter((m) => m.capability.includes(capability))
      .filter((m) => m.costPerTokenUsd * Math.max(0, promptTokenEstimate) <= maxCost)
      .sort((a, b) => a.costPerTokenUsd - b.costPerTokenUsd || a.tier - b.tier);

    if (capable.length === 0) {
      // Fall back to cheapest capable ignoring cost cap to avoid hard failure.
      const anyCapable = this.registry
        .filter((m) => m.capability.includes(capability))
        .sort((a, b) => a.costPerTokenUsd - b.costPerTokenUsd || a.tier - b.tier);
      if (anyCapable.length === 0) {
        throw new Error(`No Venice model registered for capability: ${capability}`);
      }
      return anyCapable[0];
    }

    for (const model of capable) {
      if (this.isCircuitOpen(model.id, now)) continue;
      const health = this.getModelHealth(model.id);
      if (health.successRate < 0.8) continue;
      return model;
    }

    // If all healthy-enough models are open/degraded, pick cheapest non-open, else cheapest.
    const nonOpen = capable.find((m) => !this.isCircuitOpen(m.id, now));
    return nonOpen ?? capable[0];
  }

  async call(
    model: string,
    prompt: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
      apiKey?: string;
      baseUrl?: string;
      fetchFn?: typeof fetch;
    },
  ): Promise<string> {
    const started = this.now();
    const fetchFn = options?.fetchFn ?? fetch;
    const apiKey = options?.apiKey ?? process.env.VENICE_API_KEY;
    const baseUrl = (options?.baseUrl ?? process.env.VENICE_BASE_URL ?? "https://api.venice.ai/api/v1").replace(/\/$/, "");
    if (!apiKey) throw new Error("VENICE_API_KEY is required");

    try {
      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? 2048,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Venice request failed (${res.status}): ${text}`);
      }
      const data = await res.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("Invalid Venice response: missing content");
      this.recordCall(model, this.now() - started, true);
      return content;
    } catch (err) {
      this.recordCall(model, this.now() - started, false);
      throw err;
    }
  }
}

let defaultRouter: VeniceRouter | null = null;

export function getVeniceRouter(): VeniceRouter {
  if (!defaultRouter) defaultRouter = new VeniceRouter();
  return defaultRouter;
}

export function resetVeniceRouterForTests(): void {
  defaultRouter = null;
}
