/**
 * Unit tests for CodingAgent  (Issue #7)
 *
 * Coverage:
 *  ✓ Normal code generation — valid AgentResult with non-empty code & explanation
 *  ✓ Blocklist rejection — UnsafeCodeRequestError thrown, Venice never called
 *  ✓ Test scaffold generation — testScaffold present & non-empty when includeTests: true
 *  ✓ Language detection accuracy — ≥ 80 % of 20 fixture descriptions
 *  ✓ Registry registration — capability "coding" registered on start()
 *  ✓ Prompt engineering — model id, prompt content, scaffold instruction
 */

import {
  CodingAgent,
  CodingOutput,
  UnsafeCodeRequestError,
  detectLanguage,
  findUnsafePattern,
} from '../../src/agents/coding/coding';
import { VeniceClient } from '../../src/venice/venice';
import { discoverAgents, clearRegistry } from '../../src/registry/registry';
import { SubTask } from '../../src/types/agent';

// ---------------------------------------------------------------------------
// Mock VeniceClient — no real HTTP calls
// ---------------------------------------------------------------------------

jest.mock('../../src/venice/venice');

const MockVeniceClient = VeniceClient as jest.MockedClass<typeof VeniceClient>;

function mockJsonResponse(
  language: string,
  code: string,
  explanation: string,
  testScaffold?: string,
): string {
  return JSON.stringify({ language, code, explanation, ...(testScaffold ? { testScaffold } : {}) });
}

function makeTask(prompt: string, options?: Record<string, unknown>): SubTask {
  return { prompt, options };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('CodingAgent', () => {
  let agent: CodingAgent;
  let mockComplete: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    clearRegistry();

    mockComplete = jest.fn().mockResolvedValue(
      mockJsonResponse(
        'TypeScript',
        'export function add(a: number, b: number): number { return a + b; }',
        'A simple addition function.',
      ),
    );
    MockVeniceClient.prototype.complete = mockComplete;

    agent = new CodingAgent(new MockVeniceClient());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Normal code generation
  // ─────────────────────────────────────────────────────────────────────────

  describe('execute — normal code generation', () => {
    it('returns AgentResult with non-empty code and explanation', async () => {
      const result = await agent.execute(makeTask('Write a TypeScript add function'));
      const data = result.data as CodingOutput;

      expect(data.code).toBeTruthy();
      expect(data.explanation).toBeTruthy();
      expect(data.language).toBe('TypeScript');
    });

    it('calls Venice with the venice-code model', async () => {
      await agent.execute(makeTask('Write a TypeScript add function'));

      expect(mockComplete).toHaveBeenCalledTimes(1);
      const [, modelId] = mockComplete.mock.calls[0] as [string, string];
      expect(modelId).toBe('venice-code');
    });

    it('returns AgentResult envelope with correct shape', async () => {
      const result = await agent.execute(makeTask('Write a TypeScript add function'));

      expect(result.agentId).toBe('coding-agent-default');
      expect(result.agentName).toBe('CodingAgent');
      expect(result.capability).toBe('coding');
      expect(result.data).toBeDefined();
    });

    it('handles a plain-text (non-JSON) model response gracefully', async () => {
      mockComplete.mockResolvedValueOnce('function add(a, b) { return a + b; }');

      const result = await agent.execute(makeTask('Write a JavaScript add function'));
      const data = result.data as CodingOutput;

      expect(data.code).toBeTruthy();
      expect(data.language).toBeTruthy();
    });

    it('strips markdown code fences from the model response', async () => {
      mockComplete.mockResolvedValueOnce(
        '```json\n' +
        JSON.stringify({ language: 'Python', code: 'def add(a, b): return a + b', explanation: 'Adds two numbers.' }) +
        '\n```',
      );

      const result = await agent.execute(makeTask('Write a Python add function'));
      const data = result.data as CodingOutput;

      expect(data.language).toBe('Python');
      expect(data.code).toBe('def add(a, b): return a + b');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Blocklist rejection
  // ─────────────────────────────────────────────────────────────────────────

  describe('execute — blocklist rejection', () => {
    const unsafePrompts = [
      'Use eval() to run dynamic code',
      'Call exec() with user input',
      'Run rm -rf on the directory',
      'Execute DROP TABLE users',
      'Use os.system to run a command',
      'Use subprocess.call with args',
      'Use child_process to spawn a shell',
      'Call shell_exec with input',
      'Use passthru() in PHP',
      'format c: /q',
    ];

    it.each(unsafePrompts)(
      'throws UnsafeCodeRequestError for: "%s"',
      async (prompt) => {
        await expect(agent.execute(makeTask(prompt))).rejects.toThrow(
          UnsafeCodeRequestError,
        );
      },
    );

    it('does NOT call Venice when the blocklist matches', async () => {
      await expect(
        agent.execute(makeTask('Use eval() to run something')),
      ).rejects.toThrow(UnsafeCodeRequestError);

      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('includes the matched pattern in the error', async () => {
      let caught: unknown;
      try {
        await agent.execute(makeTask('Call exec() here'));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnsafeCodeRequestError);
      expect((caught as UnsafeCodeRequestError).matchedPattern).toBeTruthy();
    });

    it('safe tasks do not throw', async () => {
      await expect(
        agent.execute(makeTask('Write a TypeScript function to add two numbers')),
      ).resolves.toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test scaffold
  // ─────────────────────────────────────────────────────────────────────────

  describe('execute — test scaffold', () => {
    it('includes testScaffold when includeTests is true and model returns it', async () => {
      mockComplete.mockResolvedValueOnce(
        mockJsonResponse(
          'TypeScript',
          'export function add(a: number, b: number): number { return a + b; }',
          'A simple addition function.',
          "import { add } from './add'; test('add', () => expect(add(1,2)).toBe(3));",
        ),
      );

      const result = await agent.execute(makeTask('Write a TypeScript add function', { includeTests: true }));
      const data = result.data as CodingOutput;

      expect(data.testScaffold).toBeTruthy();
      expect(data.testScaffold!.length).toBeGreaterThan(0);
    });

    it('provides a fallback testScaffold when includeTests is true but model omits it', async () => {
      mockComplete.mockResolvedValueOnce(
        mockJsonResponse('TypeScript', 'export const foo = () => 42;', 'Returns 42.'),
      );

      const result = await agent.execute(makeTask('Write a TypeScript function', { includeTests: true }));
      const data = result.data as CodingOutput;

      expect(data.testScaffold).toBeTruthy();
    });

    it('does NOT include testScaffold when includeTests is false', async () => {
      const result = await agent.execute(makeTask('Write a TypeScript add function', { includeTests: false }));
      const data = result.data as CodingOutput;

      expect(data.testScaffold).toBeUndefined();
    });

    it('does NOT include testScaffold when options are omitted', async () => {
      const result = await agent.execute(makeTask('Write a TypeScript add function'));
      const data = result.data as CodingOutput;

      expect(data.testScaffold).toBeUndefined();
    });

    it('passes TEST_SCAFFOLD instruction in the prompt to Venice', async () => {
      await agent.execute(makeTask('Write a Python function', { includeTests: true }));

      const [promptArg] = mockComplete.mock.calls[0] as [string];
      expect(promptArg).toMatch(/TEST_SCAFFOLD/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Language detection — ≥ 80 % accuracy
  // ─────────────────────────────────────────────────────────────────────────

  describe('detectLanguage — heuristic map', () => {
    const fixtures: Array<{ description: string; expected: string }> = [
      { description: 'Write a TypeScript interface', expected: 'TypeScript' },
      { description: 'Create a .tsx React component', expected: 'TypeScript' },
      { description: 'Implement a JavaScript class', expected: 'JavaScript' },
      { description: 'Node.js HTTP server', expected: 'JavaScript' },
      { description: 'Write a Python script', expected: 'Python' },
      { description: 'Build a Rust struct with methods', expected: 'Rust' },
      { description: 'Cargo workspace setup', expected: 'Rust' },
      { description: 'Create a Go HTTP handler', expected: 'Go' },
      { description: 'Implement a Java class', expected: 'Java' },
      { description: 'Write a C# controller', expected: 'C#' },
      { description: 'C++ template function', expected: 'C++' },
      { description: 'Kotlin data class', expected: 'Kotlin' },
      { description: 'Swift struct with protocol', expected: 'Swift' },
      { description: 'PHP function for user auth', expected: 'PHP' },
      { description: 'Ruby on Rails model', expected: 'Ruby' },
      { description: 'Bash script to backup files', expected: 'Bash' },
      { description: 'SQL query to join tables', expected: 'SQL' },
      { description: 'Solidity ERC-20 token contract', expected: 'Solidity' },
      { description: 'Soroban smart contract in Stellar', expected: 'Rust' },
      { description: 'Build a function for TypeScript project', expected: 'TypeScript' },
    ];

    it('detects language correctly for ≥ 80 % of fixtures', () => {
      const total = fixtures.length;
      let correct = 0;

      for (const { description, expected } of fixtures) {
        const detected = detectLanguage(description);
        if (detected === expected) correct += 1;
        else console.warn(`  ⚠ Mismatch: "${description}" → "${detected}" (expected "${expected}")`);
      }

      const accuracy = correct / total;
      console.log(`Language detection accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${total})`);
      expect(accuracy).toBeGreaterThanOrEqual(0.8);
    });

    it('returns TypeScript as default for an unrecognised description', () => {
      expect(detectLanguage('write me something awesome')).toBe('TypeScript');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Registry registration
  // ─────────────────────────────────────────────────────────────────────────

  describe('start — capability registration', () => {
    it('registers the agent with capability "coding"', () => {
      agent.start();
      const found = discoverAgents('coding');
      expect(found.length).toBeGreaterThan(0);
      expect(found[0].capability).toBe('coding');
    });

    it('registered agent has the correct name', () => {
      agent.start();
      const found = discoverAgents('coding');
      expect(found[0].name).toBe('CodingAgent');
    });

    it('does not duplicate entries on repeated start() calls', () => {
      agent.start();
      agent.start();
      const found = discoverAgents('coding').filter((a) => a.id === agent.agentId);
      expect(found.length).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // findUnsafePattern helper
  // ─────────────────────────────────────────────────────────────────────────

  describe('findUnsafePattern', () => {
    it('returns null for safe input', () => {
      expect(findUnsafePattern('Write a function to add two numbers')).toBeNull();
    });

    it('returns the matched pattern source for unsafe input', () => {
      expect(findUnsafePattern('Use eval() here')).not.toBeNull();
    });

    it('is case-insensitive', () => {
      expect(findUnsafePattern('DROP TABLE users')).not.toBeNull();
      expect(findUnsafePattern('drop table users')).not.toBeNull();
      expect(findUnsafePattern('Drop Table Users')).not.toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Prompt engineering
  // ─────────────────────────────────────────────────────────────────────────

  describe('prompt engineering', () => {
    it('includes language name in the prompt', async () => {
      await agent.execute(makeTask('Write a Python function to parse JSON'));
      const [promptArg] = mockComplete.mock.calls[0] as [string];
      expect(promptArg).toMatch(/Python/);
    });

    it('includes the task description in the prompt', async () => {
      const prompt = 'Write a TypeScript function to add two numbers';
      await agent.execute(makeTask(prompt));
      const [promptArg] = mockComplete.mock.calls[0] as [string];
      expect(promptArg).toContain(prompt);
    });

    it('does NOT include TEST_SCAFFOLD instruction when includeTests is false', async () => {
      await agent.execute(makeTask('Write a TypeScript function', { includeTests: false }));
      const [promptArg] = mockComplete.mock.calls[0] as [string];
      expect(promptArg).not.toMatch(/TEST_SCAFFOLD/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // healthCheck
  // ─────────────────────────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('returns true when Venice responds', async () => {
      mockComplete.mockResolvedValueOnce('pong');
      await expect(agent.healthCheck()).resolves.toBe(true);
    });

    it('returns false (does not throw) when Venice errors', async () => {
      mockComplete.mockRejectedValueOnce(new Error('network error'));
      await expect(agent.healthCheck()).resolves.toBe(false);
    });
  });
});
