/**
 * Model pricing for cost attribution (Issue #390).
 *
 * Venice bills in VVV, but the issue asks for cost "surfaced in stats and UI",
 * which is only useful in a unit operators already think in. We therefore
 * price in USD per 1M tokens and *also* record the raw token counts, so a
 * caller who wants to settle in VVV can reprice without re-running anything.
 *
 * The table is a starting point, not a contract: every rate is overridable via
 * `VENICE_PRICING_<MODEL>` (see {@link parsePricingOverrides}) so a deployment
 * on a negotiated rate or a different provider does not need a code change.
 */

export interface ModelPricing {
  /** USD per 1M input (prompt) tokens. */
  inputUsdPerMillion: number;
  /** USD per 1M output (completion) tokens. */
  outputUsdPerMillion: number;
  /** Currency the rates are quoted in. */
  currency: 'USD';
}

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Default rates. Open-weights models Venice serves are cheap relative to
 * frontier closed models; the two buckets below are a deliberate coarse split
 * rather than a per-model catalogue, so we prefer env overrides in production.
 */
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'llama-3.3-70b': { inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.4, currency: 'USD' },
  'venice-xl': { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.3, currency: 'USD' },
  'venice-code': { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.3, currency: 'USD' },
  'venice-pro': { inputUsdPerMillion: 0.4, outputUsdPerMillion: 0.8, currency: 'USD' },
};
/** Models with no explicit entry fall back to this, the cheapest bucket. */
const FALLBACK_PRICING: ModelPricing = {
  inputUsdPerMillion: 0.2,
  outputUsdPerMillion: 0.4,
  currency: 'USD',
};

let overrides: Record<string, ModelPricing> = {};

/**
 * Parse `VENICE_PRICING_<MODEL>=<input>,<output>` overrides.
 *
 * The model name is lower-cased and non-alphanumerics collapsed to `_`, so
 * `VENICE_PRICING_VENICE_XL` and `VENICE_PRICING_LLAMA_3_3_70B` both work
 * regardless of how the operator wrote the model id. Rates are
 * USD-per-million-tokens, separated by `:` (or `,`).
 */
export function parsePricingOverrides(spec: string | undefined): Record<string, ModelPricing> {
  if (!spec) return {};
  const parsed: Record<string, ModelPricing> = {};
  for (const entry of spec.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [rawModel, rates] = trimmed.split('=');
    if (!rawModel || !rates) continue;
    const [input, output] = rates.split(':');
    const inputRate = Number(input);
    const outputRate = Number(output);
    if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) continue;
    parsed[normalizeModelKey(rawModel)] = {
      inputUsdPerMillion: inputRate,
      outputUsdPerMillion: outputRate,
      currency: 'USD',
    };
  }
  return parsed;
}

/** `llama-3.3-70b` and `LLAMA_3_3_70B` must resolve to the same key. */
function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/**
 * `DEFAULT_PRICING` keyed by `normalizeModelKey`, so a lookup and the table
 * agree. Built once at module load; `DEFAULT_PRICING` stays the readable source
 * of truth.
 */
const NORMALIZED_DEFAULT_PRICING: Record<string, ModelPricing> = Object.fromEntries(
  Object.entries(DEFAULT_PRICING).map(([model, pricing]) => [normalizeModelKey(model), pricing]),
);

/** Install overrides parsed from the environment. Call once at startup. */
export function setPricingOverrides(spec: string | undefined): void {
  overrides = parsePricingOverrides(spec);
}

/** Reset to built-in defaults. Used by tests. */
export function resetPricingOverrides(): void {
  overrides = {};
}

/**
 * Resolve pricing for a model. Unknown models deliberately fall back to the
 * cheapest bucket rather than throwing: an unpriced call should still be
 * accounted for, because *under*-reporting cost is the failure mode that makes
 * a budget meaningless.
 */
export function pricingForModel(model: string | undefined): ModelPricing {
  const key = normalizeModelKey(model ?? '');
  return (
    overrides[key] ??
    // Look up through the normalized view of the table too. The literal keys
    // above are hyphenated for readability (`venice-pro`), while `key` is
    // underscored (`venice_pro`); indexing the raw table would miss every entry
    // and silently bill venice-pro at the fallback rate.
    NORMALIZED_DEFAULT_PRICING[key] ??
    FALLBACK_PRICING
  );
}

/**
 * Cost in USD for a given token split. Rounded to 6 decimals — small enough
 * that a few-cent run does not round to a misleadingly round number, large
 * enough to avoid float noise in JSON.
 */
export function computeCostUsd(
  model: string | undefined,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = pricingForModel(model);
  const inputCost = (Math.max(0, promptTokens) / TOKENS_PER_MILLION) * pricing.inputUsdPerMillion;
  const outputCost = (Math.max(0, completionTokens) / TOKENS_PER_MILLION) * pricing.outputUsdPerMillion;
  const total = inputCost + outputCost;
  return Math.round(total * 1e6) / 1e6;
}
