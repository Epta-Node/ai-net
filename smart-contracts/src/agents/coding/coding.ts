/**
 * CodingAgent
 *
 * Generates, reviews, or scaffolds code from a task description.
 *
 * Key behaviours
 * ──────────────
 * • Routes exclusively to the `venice-code` model via VeniceClient.
 * • Detects the programming language from the task description using a
 *   heuristic map before calling the model.
 * • Rejects prompts that match a blocklist of dangerous patterns by throwing
 *   UnsafeCodeRequestError (no Venice call is made).
 * • When task.options.includeTests === true the system prompt asks the model
 *   to include a test scaffold, and the output populates `testScaffold`.
 * • Registers itself in the in-memory registry with capability "coding" on
 *   startup via start().
 *
 * Output schema: { language, code, explanation, testScaffold? }
 *
 * See Issue #7 for full specification.
 */

import { VeniceClient } from '../../venice/venice';
import { registerAgent } from '../../registry/registry';
import { Agent, AgentResult, SubTask, CodingOutput } from '../../types/types';

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

/**
 * Thrown when a task description matches the dangerous-code blocklist.
 * The Venice API is never called when this error is raised.
 */
export class UnsafeCodeRequestError extends Error {
  public readonly matchedPattern: string;

  constructor(matchedPattern: string) {
    super(
      `Unsafe code request detected. Matched blocklist pattern: "${matchedPattern}"`,
    );
    this.name = 'UnsafeCodeRequestError';
    this.matchedPattern = matchedPattern;
  }
}

// ---------------------------------------------------------------------------
// Blocklist
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate a request for dangerous or malicious code.
 * Evaluated case-insensitively against the task description.
 * The Venice API is NOT called if any pattern matches.
 */
export const UNSAFE_PATTERNS: RegExp[] = [
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /rm\s+-rf\b/i,
  /DROP\s+TABLE/i,
  /\bos\.system\b/i,
  /\bsubprocess\.call\b/i,
  /\bchild_process\b/i,
  /\bshell_exec\b/i,
  /\bpassthru\b/i,
  /format\s+c:/i,
];

/**
 * Check the task description against the blocklist.
 * Returns the first matched pattern string, or null if safe.
 */
export function findUnsafePattern(description: string): string | null {
  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.test(description)) {
      return pattern.source;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/**
 * Heuristic map: keyword/phrase → canonical language name.
 * Evaluated in order; the first match wins.
 */
export const LANGUAGE_HINTS: Array<{ pattern: RegExp; language: string }> = [
  { pattern: /\btypescript\b|\btsx?\b/i, language: 'TypeScript' },
  { pattern: /\bjavascript\b|\bnode\.?js\b/i, language: 'JavaScript' },
  { pattern: /\bpython\b|\bpython3\b|\bpy\b/i, language: 'Python' },
  { pattern: /\brust\b|\bcargo\b/i, language: 'Rust' },
  { pattern: /\bgolang\b|\bgo\b/i, language: 'Go' },
  // C# and C++ before Java/C to avoid partial matches
  { pattern: /\bc#\b|\bcsharp\b|\.net\b/i, language: 'C#' },
  { pattern: /c\+\+|cpp\b/i, language: 'C++' },
  { pattern: /\bjava\b(?!script)/i, language: 'Java' },
  { pattern: /\bc\b(?!\+\+|#)/i, language: 'C' },
  { pattern: /\bkotlin\b/i, language: 'Kotlin' },
  { pattern: /\bswift\b/i, language: 'Swift' },
  { pattern: /\bphp\b/i, language: 'PHP' },
  { pattern: /\bruby\b|\brails\b/i, language: 'Ruby' },
  { pattern: /\bscala\b/i, language: 'Scala' },
  { pattern: /\br\b(?:\s+script|\s+code|\s+function)/i, language: 'R' },
  { pattern: /\bbash\b|\bshell\b|\bsh\b/i, language: 'Bash' },
  { pattern: /\bsql\b/i, language: 'SQL' },
  { pattern: /\bhtml\b/i, language: 'HTML' },
  { pattern: /\bcss\b/i, language: 'CSS' },
  { pattern: /\bsolidity\b/i, language: 'Solidity' },
  { pattern: /\bsoroban\b|\bstellar\b/i, language: 'Rust' }, // Soroban contracts are Rust
];

/** Default language when no hint can be detected. */
export const DEFAULT_LANGUAGE = 'TypeScript';

/**
 * Detect the programming language from a task description.
 * Returns the canonical language name, or DEFAULT_LANGUAGE as fallback.
 */
export function detectLanguage(description: string): string {
  for (const { pattern, language } of LANGUAGE_HINTS) {
    if (pattern.test(description)) {
      return language;
    }
  }
  return DEFAULT_LANGUAGE;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(language: string, includeTests: boolean): string {
  const testInstruction = includeTests
    ? `\n\nIn addition to the main implementation, include a TEST SCAFFOLD section ` +
      `clearly delimited with:\n` +
      `===TEST_SCAFFOLD_START===\n` +
      `<test code here>\n` +
      `===TEST_SCAFFOLD_END===\n` +
      `The test scaffold should contain meaningful unit tests for the generated code.`
    : '';

  return (
    `You are an expert ${language} developer. When asked to generate or review code, you must:\n` +
    `1. Follow ${language} best practices and idiomatic style.\n` +
    `2. Include clear inline comments explaining non-obvious logic.\n` +
    `3. Keep code concise, readable, and production-ready.\n` +
    `4. Return your response as valid JSON with the following fields:\n` +
    `   {\n` +
    `     "language": "${language}",\n` +
    `     "code": "<the generated code>",\n` +
    `     "explanation": "<a concise explanation of what the code does and key design decisions>"\n` +
    `   }\n` +
    `5. Do NOT include markdown fences around the JSON — return raw JSON only.` +
    testInstruction
  );
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parse the Venice model response into a CodingOutput.
 * Handles JSON that may be wrapped in markdown code fences.
 */
function parseModelResponse(raw: string, language: string): CodingOutput {
  // Strip optional ```json … ``` fences
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: Partial<CodingOutput> & { testScaffold?: string };

  try {
    parsed = JSON.parse(stripped) as typeof parsed;
  } catch {
    // Fallback: model didn't return JSON — treat entire response as the code
    return {
      language,
      code: raw.trim(),
      explanation: 'The model returned plain text instead of JSON.',
    };
  }

  // Extract test scaffold from delimiters if present inside code or explanation
  const combined = [parsed.code ?? '', parsed.explanation ?? ''].join('\n');
  const scaffoldMatch = combined.match(
    /===TEST_SCAFFOLD_START===\n([\s\S]*?)\n===TEST_SCAFFOLD_END===/,
  );

  let code = (parsed.code ?? '').replace(
    /\n?===TEST_SCAFFOLD_START===[\s\S]*?===TEST_SCAFFOLD_END===/,
    '',
  );

  // Some models embed the scaffold as a top-level field; honour that too
  const testScaffold = parsed.testScaffold ?? scaffoldMatch?.[1]?.trim();

  return {
    language: parsed.language ?? language,
    code: code.trim() || raw.trim(),
    explanation: (parsed.explanation ?? '').trim() || 'No explanation provided.',
    ...(testScaffold ? { testScaffold } : {}),
  };
}

// ---------------------------------------------------------------------------
// CodingAgent
// ---------------------------------------------------------------------------

export class CodingAgent implements Agent {
  private readonly venice: VeniceClient;

  /** Unique agent id used for registry registration. */
  public readonly agentId = 'coding-agent-default';

  constructor(venice?: VeniceClient) {
    this.venice = venice ?? new VeniceClient();
  }

  // -------------------------------------------------------------------------
  // Agent interface
  // -------------------------------------------------------------------------

  /**
   * Execute a code generation / review task.
   *
   * Steps:
   *  1. Validate against the unsafe-code blocklist (throws UnsafeCodeRequestError).
   *  2. Detect the programming language from the description.
   *  3. Build a system prompt (with optional test-scaffold instruction).
   *  4. Call Venice via the `venice-code` model.
   *  5. Parse and return the structured CodingOutput.
   *
   * The returned AgentResult wraps the CodingOutput in the standard schema
   * so it is compatible with the Coordinator / DAG pipeline.
   */
  async execute(task: SubTask): Promise<AgentResult & { codingOutput: CodingOutput }> {
    const { description, options } = task;
    const includeTests = options?.includeTests === true;

    // ── 1. Blocklist check ─────────────────────────────────────────────────
    const unsafeMatch = findUnsafePattern(description);
    if (unsafeMatch !== null) {
      throw new UnsafeCodeRequestError(unsafeMatch);
    }

    // ── 2. Language detection ──────────────────────────────────────────────
    const language = detectLanguage(description);

    // ── 3. Prompt engineering ──────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(language, includeTests);
    const fullPrompt = `${systemPrompt}\n\nTask: ${description}`;

    // ── 4. Venice call (venice-code model) ────────────────────────────────
    const raw = await this.venice.complete(fullPrompt, 'venice-code');

    // ── 5. Parse response ─────────────────────────────────────────────────
    const codingOutput = parseModelResponse(raw, language);

    // Ensure testScaffold is present when requested (belt-and-braces)
    if (includeTests && !codingOutput.testScaffold) {
      codingOutput.testScaffold = `// TODO: add tests for the generated ${language} code`;
    }

    // Wrap in the standard AgentResult envelope
    return {
      summary: codingOutput.explanation,
      keyFindings: [
        `Language: ${codingOutput.language}`,
        `Code length: ${codingOutput.code.length} characters`,
        includeTests ? 'Test scaffold included' : 'Test scaffold not requested',
      ],
      sources: [],
      confidence: 0.9,
      codingOutput,
    };
  }

  /**
   * Liveness probe — returns true if Venice is reachable with a trivial prompt.
   * Returns false (does NOT throw) on any error.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.venice.complete('ping', 'venice-code');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Register this agent in the registry with capability "coding".
   * Must be called before the agent can be discovered by the Coordinator.
   */
  async start(): Promise<void> {
    registerAgent({
      id: this.agentId,
      name: 'CodingAgent',
      capability: 'coding',
      priceXLM: 0.5,
      stellarAddress: '',
    });
  }
}
