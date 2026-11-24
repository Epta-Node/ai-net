/**
 * Budget limits resolved from environment config.
 *
 * Kept separate from the ledger so the coordinator can be constructed with
 * explicit limits in tests without a config object, while production picks up
 * `TASK_TOKEN_BUDGET` and friends.
 */

import { getConfig } from '../../config/index.js';
import type { BudgetLimits } from './ledger.js';

const FALLBACK_LIMITS: BudgetLimits = {
  maxTokensPerTask: 200_000,
  maxTokensPerCall: 8_192,
  maxPromptTokens: 16_000,
};

/** Read limits from env, tolerating an unconfigured/absent config module. */
export function budgetLimitsFromEnv(): BudgetLimits {
  try {
    const config = getConfig() as any;
    return {
      maxTokensPerTask: config.TASK_TOKEN_BUDGET ?? FALLBACK_LIMITS.maxTokensPerTask,
      maxTokensPerCall: config.LLM_MAX_TOKENS_PER_CALL ?? FALLBACK_LIMITS.maxTokensPerCall,
      maxPromptTokens: config.LLM_MAX_PROMPT_TOKENS ?? FALLBACK_LIMITS.maxPromptTokens,
    };
  } catch {
    return { ...FALLBACK_LIMITS };
  }
}
