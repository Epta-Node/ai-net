/**
 * ReportAgent - Assembles comprehensive reports from upstream agent results.
 * 
 * Throws InsufficientContextError when upstreamResults is empty.
 */

import { z } from 'zod';
import { BaseAgent, type AgentTask, type AgentError } from '../base/BaseAgent';

export class InsufficientContextError extends Error {
  constructor(message = 'No upstream agent results provided') {
    super(message);
    this.name = 'InsufficientContextError';
  }
}

const SectionSchema = z.object({
  heading: z.string().min(1),
  content: z.string().min(1),
  sourceAgents: z.array(z.string()),
});

const ReportOutputSchema = z.object({
  title: z.string().min(1),
  sections: z.array(SectionSchema).min(5), // 5 mandatory sections
  wordCount: z.number().min(1),
  generatedAt: z.string(),
});

type ReportOutput = z.infer<typeof ReportOutputSchema>;

const MANDATORY_SECTION_HEADINGS = [
  'Executive Summary',
  'Findings',
  'Risk Analysis',
  'Recommendations',
  'Conclusion',
] as const;

const SYSTEM_PROMPT = `You are an expert report writer. Synthesize the provided upstream results into a comprehensive markdown report with exactly 5 sections and return ONLY a valid JSON object:
{
  "title": "string",
  "sections": [
    {
      "heading": "Executive Summary",
      "content": "markdown content",
      "sourceAgents": ["agent names"]
    },
    {
      "heading": "Findings", 
      "content": "markdown content",
      "sourceAgents": ["agent names"]
    },
    {
      "heading": "Risk Analysis",
      "content": "markdown content", 
      "sourceAgents": ["agent names"]
    },
    {
      "heading": "Recommendations",
      "content": "markdown content",
      "sourceAgents": ["agent names"]
    },
    {
      "heading": "Conclusion",
      "content": "markdown content",
      "sourceAgents": ["agent names"]
    }
  ],
  "wordCount": number,
  "generatedAt": "ISO string"
}
Use the exact section headings shown above. Write professional, comprehensive content.`;

const JSON_MODE_ADDENDUM = `\n\nCRITICAL: Your response was not valid JSON. You MUST respond with ONLY a raw JSON object with exactly 5 sections using these headings:
"Executive Summary", "Findings", "Risk Analysis", "Recommendations", "Conclusion"`;

export class ReportAgent extends BaseAgent {
  getCapability(): string {
    return 'report';
  }

  getOutputSchema(): z.ZodSchema {
    return ReportOutputSchema;
  }

  async execute(task: AgentTask): Promise<ReportOutput | AgentError> {
    const { prompt, context, upstreamResults } = task;

    // Throw error if no upstream results provided
    if (!upstreamResults || upstreamResults.length === 0) {
      throw new InsufficientContextError('No upstream agent results provided for report generation');
    }

    const upstreamContext = JSON.stringify(upstreamResults, null, 2);
    const userContent = `${prompt}

Upstream Results:
${upstreamContext}

${context ? `\nAdditional context:\n${context}` : ''}`;

    const result = await this.callVeniceWithRetry(
      SYSTEM_PROMPT,
      userContent,
      JSON_MODE_ADDENDUM
    );

    if (typeof result === 'object' && result !== null && 'error' in result) {
      return result as AgentError;
    }

    const reportOutput = result as ReportOutput;

    // Validate that all mandatory sections are present
    const sectionHeadings = reportOutput.sections.map(s => s.heading);
    for (const requiredHeading of MANDATORY_SECTION_HEADINGS) {
      if (!sectionHeadings.includes(requiredHeading)) {
        return { error: 'VENICE_MALFORMED_RESPONSE' };
      }
    }

    // Set generated timestamp
    reportOutput.generatedAt = new Date().toISOString();
    
    // Calculate word count
    reportOutput.wordCount = this.calculateWordCount(reportOutput.sections);

    return reportOutput;
  }

  private calculateWordCount(sections: { content: string }[]): number {
    return sections.reduce((total, section) => {
      const words = section.content
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 0);
      return total + words.length;
    }, 0);
  }
}
