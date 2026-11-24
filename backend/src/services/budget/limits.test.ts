jest.mock("../../config/index.js", () => ({
  getConfig: jest.fn(),
}));

import { getConfig } from "../../config/index.js";
import { budgetLimitsFromEnv } from "./limits.js";

const mockGetConfig = getConfig as jest.Mock;

beforeEach(() => {
  mockGetConfig.mockReset();
});

describe("budgetLimitsFromEnv", () => {
  it("maps configured values", () => {
    mockGetConfig.mockReturnValue({
      TASK_TOKEN_BUDGET: 500,
      LLM_MAX_TOKENS_PER_CALL: 32,
      LLM_MAX_PROMPT_TOKENS: 64,
    });

    expect(budgetLimitsFromEnv()).toEqual({
      maxTokensPerTask: 500,
      maxTokensPerCall: 32,
      maxPromptTokens: 64,
    });
  });

  it("preserves zero values instead of falling back", () => {
    mockGetConfig.mockReturnValue({
      TASK_TOKEN_BUDGET: 0,
      LLM_MAX_TOKENS_PER_CALL: 0,
      LLM_MAX_PROMPT_TOKENS: 0,
    });

    expect(budgetLimitsFromEnv()).toEqual({
      maxTokensPerTask: 0,
      maxTokensPerCall: 0,
      maxPromptTokens: 0,
    });
  });

  it("falls back per field when values are missing", () => {
    mockGetConfig.mockReturnValue({ TASK_TOKEN_BUDGET: 42 });

    expect(budgetLimitsFromEnv()).toEqual({
      maxTokensPerTask: 42,
      maxTokensPerCall: 8192,
      maxPromptTokens: 16000,
    });
  });

  it("falls back when config is unavailable", () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("not configured");
    });

    expect(budgetLimitsFromEnv()).toEqual({
      maxTokensPerTask: 200000,
      maxTokensPerCall: 8192,
      maxPromptTokens: 16000,
    });
  });
});
