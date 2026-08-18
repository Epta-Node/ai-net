/**
 * DesignAgent - Generates UI/UX design specifications.
 */

import { z } from 'zod';
import { BaseAgent, type AgentTask, type AgentError } from '../base/BaseAgent';

const WireframeSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  components: z.array(z.string()),
});

const ColorPaletteSchema = z.object({
  name: z.string().min(1),
  hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  usage: z.string().min(1),
});

const ComponentHierarchySchema = z.object({
  component: z.string().min(1),
  children: z.array(z.string()),
  props: z.array(z.string()).optional(),
});

const AssetManifestSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  dimensions: z.string().optional(),
});

const DesignOutputSchema = z.object({
  wireframes: z.array(WireframeSchema),
  colorPalette: z.array(ColorPaletteSchema),
  componentHierarchy: z.array(ComponentHierarchySchema),
  assetManifest: z.array(AssetManifestSchema),
});

type DesignOutput = z.infer<typeof DesignOutputSchema>;

const SYSTEM_PROMPT = `You are a UI/UX design expert. Create comprehensive design specifications and return ONLY a valid JSON object with this structure:
{
  "wireframes": [
    {
      "name": "string",
      "description": "string", 
      "components": ["string"]
    }
  ],
  "colorPalette": [
    {
      "name": "string",
      "hex": "#RRGGBB",
      "usage": "string"
    }
  ],
  "componentHierarchy": [
    {
      "component": "string",
      "children": ["string"],
      "props": ["string"]
    }
  ],
  "assetManifest": [
    {
      "type": "string",
      "name": "string",
      "description": "string",
      "dimensions": "string"
    }
  ]
}
Focus on user-centered design, accessibility, and modern design patterns.`;

const JSON_MODE_ADDENDUM = `\n\nCRITICAL: Your response was not valid JSON. You MUST respond with ONLY a raw JSON object that matches this schema:
{
  "wireframes": [{"name": "string", "description": "string", "components": ["string"]}],
  "colorPalette": [{"name": "string", "hex": "#RRGGBB", "usage": "string"}],
  "componentHierarchy": [{"component": "string", "children": ["string"], "props": ["string"]}],
  "assetManifest": [{"type": "string", "name": "string", "description": "string", "dimensions": "string"}]
}`;

export class DesignAgent extends BaseAgent {
  getCapability(): string {
    return 'design';
  }

  getOutputSchema(): z.ZodSchema {
    return DesignOutputSchema;
  }

  async execute(task: AgentTask): Promise<DesignOutput | AgentError> {
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

    return result as DesignOutput;
  }
}
