/**
 * RiskAgent - Analyzes risks and returns structured risk assessments.
 * 
 * Marks items with likelihood >= 4 AND impact >= 4 as critical.
 */

import { z } from 'zod';
import { BaseAgent, type AgentTask, type AgentError } from '../base/BaseAgent';

const RiskItemSchema = z.object({
  category: z.string().min(1),
  description: z.string().min(1),
  likelihood: z.number().min(1).max(5),
  impact: z.number().min(1).max(5),
  mitigations: z.array(z.string()),
  critical: z.boolean().optional(),
});

const RiskOutputSchema = z.object({
  risks: z.array(RiskItemSchema),
  overallRiskScore: z.number().min(0).max(5),
});

type RiskOutput = z.infer<typeof RiskOutputSchema>;

const SYSTEM_PROMPT = `You are a risk analysis expert. Analyze the given scenario and return ONLY a valid JSON object with the following structure:
{
  "risks": [
    {
      "category": "string (e.g., 'Market', 'Technical', 'Regulatory')",
      "description": "string",
      "likelihood": number (1-5 scale),
      "impact": number (1-5 scale),
      "mitigations": ["string"]
    }
  ],
  "overallRiskScore": number (0-5 scale, weighted average)
}
Provide thorough risk analysis with realistic likelihood and impact scores.`;

const JSON_MODE_ADDENDUM = `\n\nCRITICAL: Your response was not valid JSON. You MUST respond with ONLY a raw JSON object that matches this schema:
{
  "risks": [{"category": "string", "description": "string", "likelihood": number, "impact": number, "mitigations": ["string"]}],
  "overallRiskScore": number
}`;

export class RiskAgent extends BaseAgent {
  getCapability(): string {
    return 'risk';
  }

  getOutputSchema(): z.ZodSchema {
    return RiskOutputSchema;
  }

  async execute(task: AgentTask): Promise<RiskOutput | AgentError> {
    const { prompt, context } = task;

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

    const riskOutput = result as RiskOutput;

    // Mark items with likelihood >= 4 AND impact >= 4 as critical
    riskOutput.risks = riskOutput.risks.map(risk => ({
      ...risk,
      critical: risk.likelihood >= 4 && risk.impact >= 4,
    }));

    return riskOutput;
  }
}
