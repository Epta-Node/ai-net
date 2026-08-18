/**
 * CodingAgent - Generates code with safety validation.
 * 
 * Routes to venice-code model and throws UnsafeCodeRequestError for blocklist matches.
 */

import { z } from 'zod';
import { BaseAgent, type AgentTask, type AgentError, type BaseAgentConfig } from '../base/BaseAgent';

export class UnsafeCodeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeCodeRequestError';
  }
}

const CodingOutputSchema = z.object({
  language: z.string().min(1),
  code: z.string().min(1),
  explanation: z.string().min(1),
  testScaffold: z.string().optional(),
});

type CodingOutput = z.infer<typeof CodingOutputSchema>;

const UNSAFE_CODE_BLOCKLIST = [
  'malware',
  'virus',
  'exploit',
  'backdoor',
  'keylogger',
  'rootkit',
  'trojan',
  'ransomware',
  'shellcode',
  'buffer overflow',
  'sql injection',
  'xss',
  'csrf',
];

const SYSTEM_PROMPT = `You are an expert software developer. Generate clean, secure, well-documented code and return ONLY a valid JSON object with this structure:
{
  "language": "string (e.g., 'python', 'javascript', 'rust')",
  "code": "string (the complete code)",
  "explanation": "string (detailed explanation)",
  "testScaffold": "string (optional test code)"
}
Focus on security best practices, clear documentation, and maintainable code.`;

const JSON_MODE_ADDENDUM = `\n\nCRITICAL: Your response was not valid JSON. You MUST respond with ONLY a raw JSON object that matches this schema:
{
  "language": "string",
  "code": "string", 
  "explanation": "string",
  "testScaffold": "string"
}`;

export class CodingAgent extends BaseAgent {
  getCapability(): string {
    return 'coding';
  }

  getOutputSchema(): z.ZodSchema {
    return CodingOutputSchema;
  }

  async execute(task: AgentTask): Promise<CodingOutput | AgentError> {
    const { prompt, context } = task;

    // Check for unsafe code request before calling Venice
    this.validateCodeSafety(prompt);
    if (context) {
      this.validateCodeSafety(context);
    }

    const userContent = context
      ? `${prompt}\n\nAdditional context:\n${context}`
      : prompt;

    const result = await this.callVeniceWithRetry(
      SYSTEM_PROMPT,
      userContent,
      JSON_MODE_ADDENDUM
    );

    if (typeof result === 'object' && result !== null && 'error' in result) {
      return result as AgentError;
    }

    return result as CodingOutput;
  }

  private validateCodeSafety(text: string): void {
    const lowerText = text.toLowerCase();
    
    for (const term of UNSAFE_CODE_BLOCKLIST) {
      if (lowerText.includes(term)) {
        throw new UnsafeCodeRequestError(
          `Unsafe code request detected: contains blocked term "${term}"`
        );
      }
    }
  }
}
